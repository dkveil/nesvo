import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  flattenGroups,
  groupDescendants,
  groupPath,
  validGroupName,
} from '../apps/mobile/src/entities/group/model/groups';
import {
  canSubmitDecision,
  decisionRefusal,
  markSubmissionsUnknown,
  mergeDecisionPage,
  normalizeDecisionAnswer,
  settleUnknownSubmissions,
  submissionKey,
} from '../apps/mobile/src/entities/inbox/model/decision-outcome';
import {
  groupInboxItems,
  markKey,
  MAX_HIDDEN_MARKS,
  mergeInboxPage,
  refreshLimit,
  rememberMark,
  restoreItems,
  withoutItems,
} from '../apps/mobile/src/entities/inbox/model/inbox-items';
import {
  attemptsLabel,
  formatInstant,
  jobStateLabel,
  retryClassLabel,
  scheduleLabel,
} from '../apps/mobile/src/entities/job/model/job-labels';
import {
  applyPage,
  MAX_LOADED_JOBS,
  mergePage,
  nextLoadablePage,
} from '../apps/mobile/src/entities/job/model/job-pages';
import {
  MAX_LINEAGE_DEPTH,
  sessionLineageRows,
} from '../apps/mobile/src/entities/session/model/session-lineage';
import {
  sessionLastKnownLabel,
  sessionReadinessLabel,
  sessionStateFreshness,
  statusNeedsAttention,
} from '../apps/mobile/src/entities/session/model/status-presentation';
import { HostClient } from '../apps/mobile/src/shared/api/host/client';
import { decodeServerMessage } from '../apps/mobile/src/shared/api/host/messages';
import type {
  ClientCommand,
  HostEvent,
  InboxItem,
  PendingDecision,
  SessionGroup,
} from '../apps/mobile/src/shared/api/host/types';
import { decodeFrame, encodeFrame } from '../apps/mobile/src/shared/api/host/wire';
import {
  parseNotificationTarget,
  parseTarget,
} from '../apps/mobile/src/shared/notifications/target';
import { formatAge, formatRemaining, hasElapsed } from '../apps/mobile/src/shared/ui/format-age';

const cliValidator = () =>
  new Ajv().compile(
    JSON.parse(readFileSync(new URL('../docs/harness-cli.schema.json', import.meta.url), 'utf8')),
  );

const groups: SessionGroup[] = [
  { id: 'child', name: 'Mobile', parentId: 'root', order: 1 },
  { id: 'other', name: 'Server', parentId: null, order: 2 },
  { id: 'root', name: 'Workspace', parentId: null, order: 0 },
  { id: 'grandchild', name: 'iPhone', parentId: 'child', order: 0 },
];
const session = {
  id: 'session',
  name: 'Shell',
  cwd: '/project',
  createdAt: '2026-10-16T12:00:00Z',
  cols: 80,
  rows: 24,
  running: true,
  groupId: 'child',
  controllerId: null,
};

test('published session schema keeps repository context optional and rejects contradictory states', () => {
  assertSessionContexts(cliValidator());
});

test('captured CLI envelopes match the generated schema', () => {
  const envelopes: unknown[] = JSON.parse(
    readFileSync(new URL('./fixtures/harness-cli-envelopes.json', import.meta.url), 'utf8'),
  );
  assert.ok(envelopes.length > 0);
  const validate = cliValidator();
  for (const [index, envelope] of envelopes.entries())
    assert.equal(validate(envelope), true, `Envelope ${index}: ${JSON.stringify(validate.errors)}`);
});

function assertSessionContexts(validate: ReturnType<Ajv['compile']>) {
  const envelope = (context?: unknown) => ({
    schemaVersion: 1,
    ok: true,
    data: {
      type: 'session',
      session: {
        ...session,
        id: '1'.repeat(32),
        ...(context === undefined ? {} : { repositoryContext: context }),
      },
    },
  });
  assert.equal(validate(envelope()), true);
  const ready = {
    source: 'launchDirectory',
    state: 'ready',
    name: 'répertoire工程',
    branch: 'feature/zażółć',
    observedAt: 7,
    revision: 2,
  };
  for (const context of [
    ready,
    { ...ready, state: 'detached', branch: null },
    { ...ready, state: 'notRepository', name: null, branch: null },
    { ...ready, state: 'stale', name: null, branch: null },
    { ...ready, state: 'checking', name: null, branch: null, observedAt: null },
    { ...ready, state: 'unavailable', name: null, branch: null, observedAt: null },
  ])
    assert.equal(validate(envelope(context)), true);
  for (const context of [
    null,
    { ...ready, state: 'guessed' },
    { ...ready, branch: null },
    { ...ready, observedAt: null },
    { ...ready, source: 'reviewFolder' },
    { ...ready, state: 'stale' },
    { ...ready, name: 'PRIVATE\nLABEL' },
    { ...ready, revision: 9007199254740992 },
    { ...ready, name: undefined },
  ])
    assert.equal(validate(envelope(context)), false);
}

function retainedSnapshot(count: number) {
  return {
    type: 'sessions',
    revision: 4,
    groups,
    sessions: Array.from({ length: count }, (_, index) => ({
      ...session,
      id: `session-${index}`,
      running: index % 2 === 0,
    })),
  };
}

test('session snapshot fixtures used by the client match the published host schema', () => {
  const validate = cliValidator();
  for (const snapshot of [
    retainedSnapshot(16),
    { type: 'sessions', groups, sessions: [session], revision: 4, requestId: 'list-1' },
  ])
    assert.equal(
      validate({ schemaVersion: 1, ok: true, data: snapshot }),
      true,
      JSON.stringify(validate.errors),
    );
});

test('session snapshots accept the host retained-record ceiling without dropping exited records', () => {
  for (const count of [0, 8, 9, 16]) {
    const snapshot = retainedSnapshot(count);
    const before = structuredClone(snapshot);
    assert.equal(decodeServerMessage(snapshot), snapshot);
    assert.deepEqual(snapshot, before, 'Validation cannot truncate or rewrite host records');
  }
});

test('sixteen-session snapshots still reject overflow, late malformed records and duplicates privately', () => {
  const snapshot = retainedSnapshot(16);
  const lastRecord = (changes: Record<string, unknown>) => ({
    ...snapshot,
    sessions: snapshot.sessions.map((item, index) =>
      index === 15 ? { ...item, ...changes } : item,
    ),
  });
  for (const invalid of [
    retainedSnapshot(17),
    lastRecord({ id: 'session-0' }),
    lastRecord({ groupId: 'missing' }),
    lastRecord({ running: 'yes' }),
    lastRecord({ name: 'PRIVATE_SESSION_NAME', cwd: '/PRIVATE_SESSION_PATH', cols: 0 }),
    { ...snapshot, sessions: [...snapshot.sessions.slice(0, 15), null] },
  ]) {
    assert.throws(() => decodeServerMessage(invalid), {
      name: 'Error',
      message: 'Invalid host message.',
    });
  }
});

test('sixteen-session shape support preserves the authenticated plaintext byte bound', () => {
  const snapshot = retainedSnapshot(16);
  const key = new Uint8Array(32).fill(7);
  const challenge = 'a'.repeat(64);
  const frame = encodeFrame(snapshot, key, challenge, 'host-to-client', 1, randomBytes);
  assert.deepEqual(
    decodeServerMessage(decodeFrame(frame, key, challenge, 'host-to-client', 1)),
    snapshot,
  );
  const oversized = {
    ...snapshot,
    sessions: snapshot.sessions.map(item => ({ ...item, cwd: `/${'x'.repeat(8192)}` })),
  };
  assert.equal(
    decodeServerMessage(oversized),
    oversized,
    'Record shape is independent of frame size',
  );
  assert.throws(() => encodeFrame(oversized, key, challenge, 'host-to-client', 1, randomBytes), {
    name: 'Error',
    message: 'Message is too large.',
  });
});

test('canonical current attention drives filtering and validates group rollups separately from history', () => {
  const status = { state: 'working', source: 'hook', updatedAt: 1 } as const;
  const currentAttention = {
    priority: 2,
    reason: 'child',
    blockedChildren: 3,
    status: { ...status, state: 'blocked' },
  } as const;
  const attentionSummary = { sessions: 1, needsYou: 1, highest: currentAttention };
  const snapshot = {
    type: 'sessions',
    revision: 0,
    groups: groups.map(g => ({ ...g, attentionSummary })),
    sessions: [
      {
        ...session,
        status,
        currentAttention,
        attention: { sequence: 1, kind: 'permission', at: 1, unread: true },
      },
    ],
  };
  assert.equal(decodeServerMessage(snapshot).type, 'sessions');
  assert.equal(statusNeedsAttention('working', currentAttention), true);
  const cleared = { priority: 0, reason: null, status: null, blockedChildren: 0 } as const;
  assert.equal(
    statusNeedsAttention('blocked', cleared),
    false,
    'canonical host projection overrides legacy inference',
  );
  for (const bad of [
    { ...currentAttention, priority: 9 },
    { ...currentAttention, reason: 'succeeded' },
    { ...cleared, reason: 'permission' },
  ]) {
    assert.throws(() =>
      decodeServerMessage({ ...snapshot, sessions: [{ ...session, currentAttention: bad }] }),
    );
  }
  assert.throws(() =>
    decodeServerMessage({
      ...snapshot,
      groups: [{ ...groups[0], attentionSummary: { ...attentionSummary, needsYou: 2 } }],
    }),
  );
});

test('readiness is independent from legacy agent state and validates at the wire boundary', () => {
  const readiness = {
    phase: 'starting',
    initialized: false,
    reason: 'awaiting provider readiness',
  } as const;
  const snapshot = { type: 'sessions', groups, sessions: [{ ...session, readiness }], revision: 0 };
  assert.equal(decodeServerMessage(snapshot).type, 'sessions');
  assert.equal(sessionReadinessLabel(readiness), 'Starting');
  assert.equal(sessionReadinessLabel({ ...readiness, phase: 'timedOut' }), 'Startup failed');
  assert.equal(sessionReadinessLabel(undefined), undefined);
  assert.throws(() =>
    decodeServerMessage({
      ...snapshot,
      sessions: [{ ...session, readiness: { ...readiness, phase: 'success' } }],
    }),
  );
});

test('process, agent and turn lifecycles cannot invent task success or revive exited agents', () => {
  const lifecycle = {
    process: { running: true, pid: 7 },
    agent: {
      current: { state: 'idle', source: 'hook', updatedAt: 1 },
      lastKnown: null,
      blockReason: null,
      freshness: 'observed',
    },
    turn: {
      id: 'launch:2',
      generation: 1,
      phase: 'settled',
      elapsedSeconds: 4,
      observedAt: 2,
      outcome: 'response ended; task result not established',
    },
  };
  const snapshot = { type: 'sessions', groups, sessions: [{ ...session, lifecycle }], revision: 0 };
  assert.equal(decodeServerMessage(snapshot).type, 'sessions');
  assert.throws(() =>
    decodeServerMessage({
      ...snapshot,
      sessions: [
        {
          ...session,
          running: false,
          lifecycle: { ...lifecycle, process: { running: false, pid: 7 } },
        },
      ],
    }),
  );
  assert.throws(() =>
    decodeServerMessage({
      ...snapshot,
      sessions: [
        {
          ...session,
          lifecycle: { ...lifecycle, turn: { ...lifecycle.turn, phase: 'succeeded' } },
        },
      ],
    }),
  );
  assert.throws(() =>
    decodeServerMessage({
      ...snapshot,
      sessions: [
        {
          ...session,
          lifecycle: {
            ...lifecycle,
            agent: {
              ...lifecycle.agent,
              current: { state: 'done', source: 'process', updatedAt: 2 },
            },
          },
        },
      ],
    }),
  );
});

test('program status retains legacy wire sources and validates structured provenance', () => {
  const status = { state: 'blocked', source: 'screen', confirmedSource: 'osc7501', updatedAt: 1 };
  const snapshot = { type: 'sessions', groups, sessions: [{ ...session, status }], revision: 0 };
  assert.equal(decodeServerMessage(snapshot).type, 'sessions');
  for (const invalid of [
    { ...status, confirmedSource: 'arbitrary' },
    { ...status, source: 'activity' },
  ])
    assert.throws(() =>
      decodeServerMessage({ ...snapshot, sessions: [{ ...session, status: invalid }] }),
    );
});

test('group navigation includes descendants, preserves sibling ordering and never mutates snapshots', () => {
  const before = structuredClone(groups);
  assert.deepEqual([...groupDescendants(groups, 'root')].sort(), ['child', 'grandchild', 'root']);
  assert.deepEqual(
    flattenGroups(groups).map(({ id, depth }) => [id, depth]),
    [
      ['root', 0],
      ['child', 1],
      ['grandchild', 2],
      ['other', 0],
    ],
  );
  assert.equal(groupPath(groups, 'grandchild'), 'Workspace / Mobile / iPhone');
  assert.equal(groupPath(groups, null), 'No group');
  assert.deepEqual(groups, before);
  assert.equal(validGroupName('  東京  '), true);
  assert.equal(validGroupName('🎯'.repeat(80)), true);
  assert.equal(validGroupName('🎯'.repeat(81)), false);
  assert.equal(validGroupName('x\x1b[0m'), false);
});

test('a validated snapshot can represent nested groups and an unowned terminal', () => {
  const snapshot = { type: 'sessions', groups, sessions: [session], revision: 4 };
  assert.deepEqual(decodeServerMessage(snapshot), snapshot);
  assert.equal(
    decodeServerMessage({
      type: 'control',
      sessionId: 'session',
      controllerId: 7,
      leaseId: 'fresh-lease',
      cols: 90,
      rows: 30,
    }).type,
    'control',
  );
  assert.equal(
    decodeServerMessage({ type: 'created', requestId: 'create-1', sessionId: 'session' }).type,
    'created',
  );
});

test('untrusted host payloads cannot introduce impossible state into the client', () => {
  const snapshot = { type: 'sessions', groups, sessions: [session], revision: 4 };
  const invalid: unknown[] = [
    null,
    [],
    { type: 'unknown' },
    { type: 'connected', clientId: 1, protocolVersion: 2, clientNonce: 'invalid' },
    { ...snapshot, revision: -1 },
    { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, groups: [...groups, groups[0]] },
    {
      ...snapshot,
      groups: groups.map(group =>
        group.id === 'root' ? { ...group, parentId: 'grandchild' } : group,
      ),
    },
    { ...snapshot, sessions: [{ ...session, groupId: 'missing' }] },
    { ...snapshot, sessions: [{ ...session, cols: 0 }] },
    { ...snapshot, sessions: [{ ...session, running: 'yes' }] },
    { ...snapshot, sessions: [{ ...session, program: 'arbitrary-command' }] },
    { ...snapshot, sessions: [session, session] },
    {
      type: 'control',
      sessionId: 'session',
      controllerId: null,
      leaseId: 'leaked',
      cols: 80,
      rows: 24,
    },
    { type: 'control', sessionId: 'session', controllerId: 2, cols: 80, rows: 99999 },
    { type: 'output', sessionId: 'session', data: {}, replay: true },
    { type: 'created', requestId: 'x'.repeat(129), sessionId: 'session' },
  ];
  for (const value of invalid)
    assert.throws(() => decodeServerMessage(value), /Invalid host message/);
});

test('launcher capabilities require the four distinct known programs and explicit availability', () => {
  const capabilities = {
    type: 'capabilities',
    workspace: 'C:\\projects',
    programs: [
      { id: 'shell', label: 'Terminal', available: true },
      { id: 'claude', label: 'Claude Code', available: true },
      { id: 'gemini', label: 'Gemini', available: false },
      { id: 'codex', label: 'Codex', available: true },
    ],
  };
  assert.deepEqual(decodeServerMessage(capabilities), capabilities);
  const withLimits = {
    ...capabilities,
    providerLimits: [
      { id: 'claude', status: 'unavailable', windows: [] },
      {
        id: 'codex',
        status: 'ready',
        windows: [{ usedPercent: 75, durationMins: 300, resetsAt: 1_792_783_619 }],
      },
    ],
  };
  assert.deepEqual(decodeServerMessage(withLimits), withLimits);
  for (const value of [
    { ...capabilities, workspace: '' },
    { ...capabilities, programs: [] },
    { ...capabilities, programs: [...capabilities.programs.slice(1), capabilities.programs[1]] },
    {
      ...capabilities,
      programs: [
        { id: 'shell', label: 'Terminal', available: 'yes' },
        ...capabilities.programs.slice(1),
      ],
    },
    {
      ...capabilities,
      programs: [
        { id: 'custom', label: 'Custom', available: true },
        ...capabilities.programs.slice(1),
      ],
    },
    { ...withLimits, providerLimits: [{ id: 'gemini', status: 'ready', windows: [] }] },
    {
      ...withLimits,
      providerLimits: [
        {
          id: 'codex',
          status: 'ready',
          windows: [{ usedPercent: 101, durationMins: 300, resetsAt: null }],
        },
      ],
    },
  ])
    assert.throws(() => decodeServerMessage(value), /Invalid host message/);
});

test('session status preserves its evidence source and rejects invented or malformed states', () => {
  const snapshot = { type: 'sessions', groups, sessions: [session], revision: 4 };
  for (const status of [
    { state: 'working', source: 'activity', updatedAt: 100 },
    { state: 'idle', source: 'activity', updatedAt: 101 },
    { state: 'question', source: 'screen', updatedAt: 102 },
    { state: 'blocked', source: 'screen', updatedAt: 103 },
    { state: 'done', source: 'process', updatedAt: 104 },
    { state: 'failed', source: 'process', updatedAt: 105 },
    { state: 'working', source: 'screen', evidence: 'hook', updatedAt: 106 },
    { state: 'idle', source: 'hook', updatedAt: 107 },
    { state: 'blocked', source: 'hook', updatedAt: 108 },
  ]) {
    const message = { ...snapshot, sessions: [{ ...session, status }] };
    assert.deepEqual(decodeServerMessage(message), message);
  }
  for (const status of [
    { state: 'complete', source: 'screen', updatedAt: 100 },
    { state: 'done', source: 'activity', updatedAt: 100 },
    { state: 'blocked', source: 'activity', updatedAt: 100 },
    { state: 'idle', source: 'process', updatedAt: 100 },
    { state: 'idle', source: 'guess', updatedAt: 100 },
    { state: 'idle', source: 'screen', updatedAt: -1 },
    { state: 'idle', source: 'screen', updatedAt: 'today' },
    null,
  ])
    assert.throws(
      () => decodeServerMessage({ ...snapshot, sessions: [{ ...session, status }] }),
      /Invalid host message/,
    );
});

test('attention and push boundaries reject malformed and cross-navigation payloads', () => {
  const attention = { sequence: 1, kind: 'question', at: 100, unread: true };
  const snapshot = {
    type: 'sessions',
    groups,
    sessions: [{ ...session, attention, muted: false }],
    revision: 1,
  };
  assert.equal(decodeServerMessage(snapshot).type, 'sessions');
  for (const invalid of [
    { ...attention, sequence: -1 },
    { ...attention, kind: 'random' },
    { ...attention, unread: 'yes' },
    { ...attention, source: ['screen'] },
  ]) {
    assert.throws(() =>
      decodeServerMessage({ ...snapshot, sessions: [{ ...session, attention: invalid }] }),
    );
  }
  assert.equal(
    decodeServerMessage({ type: 'pushRegistered', enabled: true, requestId: 'x' }).type,
    'pushRegistered',
  );
  assert.throws(() => decodeServerMessage({ type: 'pushRegistered', enabled: 'true' }));
  const target = { hostId: 'a'.repeat(32), sessionId: 'b'.repeat(32), sequence: 1 };
  assert.deepEqual(parseTarget(target), target);
  assert.equal(parseTarget({ ...target, sessionId: '../../settings' }), null);
  assert.equal(parseTarget({ ...target, hostId: 'https://malicious.example' }), null);
  assert.equal(parseTarget({ ...target, sequence: Infinity }), null);
});

test('optional host session uptime is bounded and legacy snapshots still decode', () => {
  const snapshot = {
    type: 'sessions',
    groups,
    sessions: [{ ...session, uptimeSeconds: 8040 }],
    revision: 4,
  };
  assert.deepEqual(decodeServerMessage(snapshot), snapshot);
  for (const uptimeSeconds of [-1, 0.5, '8040', Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => decodeServerMessage({ ...snapshot, sessions: [{ ...session, uptimeSeconds }] }),
      /Invalid host message/,
    );
});

const repositoryContext = {
  source: 'launchDirectory',
  state: 'ready',
  name: 'répertoire工程',
  branch: 'feature/zażółć',
  observedAt: 1_792_545_000_000,
  revision: 2,
} as const;

test('optional launch-directory repository context preserves legacy and Unicode snapshots', () => {
  const legacy = retainedSnapshot(16);
  assert.equal(decodeServerMessage(legacy), legacy);
  assert.equal(Object.hasOwn(legacy.sessions[0] ?? {}, 'repositoryContext'), false);
  const contexts = [
    repositoryContext,
    { ...repositoryContext, state: 'detached', branch: null },
    { ...repositoryContext, state: 'notRepository', name: null, branch: null },
    { ...repositoryContext, state: 'stale', name: null, branch: null },
    {
      ...repositoryContext,
      state: 'checking',
      name: null,
      branch: null,
      observedAt: null,
    },
    {
      ...repositoryContext,
      state: 'unavailable',
      name: null,
      branch: null,
      observedAt: null,
    },
  ];
  for (const context of contexts) {
    const snapshot = {
      ...legacy,
      sessions: legacy.sessions.map(item => ({ ...item, repositoryContext: context })),
    };
    const before = structuredClone(snapshot);
    assert.equal(decodeServerMessage(snapshot), snapshot);
    assert.deepEqual(snapshot, before, 'Context validation cannot rewrite the host snapshot');
    const key = new Uint8Array(32).fill(9);
    const challenge = 'b'.repeat(64);
    const frame = encodeFrame(snapshot, key, challenge, 'host-to-client', 1, randomBytes);
    assert.deepEqual(
      decodeServerMessage(decodeFrame(frame, key, challenge, 'host-to-client', 1)),
      snapshot,
    );
  }
});

test('repository context labels use UTF-8 byte bounds and safe metadata integers', () => {
  for (const context of [
    { ...repositoryContext, name: 'é'.repeat(64), branch: '界'.repeat(85) },
    {
      ...repositoryContext,
      name: '🎯'.repeat(32),
      branch: '🎯'.repeat(64),
      observedAt: Number.MAX_SAFE_INTEGER,
      revision: Number.MAX_SAFE_INTEGER,
    },
    { ...repositoryContext, observedAt: 0, revision: 0 },
  ]) {
    const snapshot = {
      type: 'sessions',
      groups,
      sessions: [{ ...session, repositoryContext: context }],
      revision: 4,
    };
    assert.equal(decodeServerMessage(snapshot), snapshot);
  }
});

test('malformed present repository context is refused privately without mutating other session data', () => {
  const invalid: unknown[] = [null, false, [], {}, 'launchDirectory'];
  for (const [field, bad] of [
    ['source', 'agentDirectory'],
    ['state', 'unknown'],
    ['name', null],
    ['name', ''],
    ['name', 'é'.repeat(65)],
    ['name', '🎯'.repeat(33)],
    ['name', 'PRIVATE_REPOSITORY_NAME\x1b'],
    ['branch', null],
    ['branch', ''],
    ['branch', '界'.repeat(86)],
    ['branch', '🎯'.repeat(65)],
    ['branch', 'feature/PRIVATE_BRANCH\n'],
    ['branch', 'feature/\x85'],
    ['branch', '\ud800'],
    ['observedAt', null],
    ['observedAt', -1],
    ['observedAt', 1.5],
    ['observedAt', Number.MAX_SAFE_INTEGER + 1],
    ['revision', -1],
    ['revision', 1.5],
    ['revision', '2'],
    ['revision', Number.MAX_SAFE_INTEGER + 1],
  ] as const)
    invalid.push({ ...repositoryContext, [field]: bad });
  for (const field of ['source', 'state', 'name', 'branch', 'observedAt', 'revision']) {
    const missing: Record<string, unknown> = { ...repositoryContext };
    delete missing[field];
    invalid.push(missing);
  }
  for (const state of ['checking', 'detached', 'notRepository', 'unavailable', 'stale'])
    invalid.push({ ...repositoryContext, state });
  for (const state of ['checking', 'unavailable'])
    invalid.push({ ...repositoryContext, state, name: null, branch: null });
  for (const state of ['detached', 'notRepository', 'stale'])
    invalid.push({
      ...repositoryContext,
      state,
      name: state === 'detached' ? repositoryContext.name : null,
      branch: null,
      observedAt: null,
    });
  for (const context of invalid) {
    const snapshot = {
      type: 'sessions',
      groups,
      sessions: [{ ...session, repositoryContext: context }],
      revision: 4,
    };
    const before = structuredClone(snapshot);
    assert.throws(() => decodeServerMessage(snapshot), {
      name: 'Error',
      message: 'Invalid host message.',
    });
    assert.deepEqual(snapshot, before);
  }
});

test('optional process lineage is validated independently from groups and authority', () => {
  for (const parentSessionId of [undefined, null, 'parent-process']) {
    const snapshot = {
      type: 'sessions',
      groups,
      sessions: [{ ...session, parentSessionId }],
      revision: 4,
    };
    assert.deepEqual(decodeServerMessage(snapshot), snapshot);
  }
  for (const parentSessionId of ['', 42, {}, 'x'.repeat(129)]) {
    assert.throws(
      () =>
        decodeServerMessage({
          type: 'sessions',
          groups,
          sessions: [{ ...session, parentSessionId }],
          revision: 4,
        }),
      /Invalid host message/,
    );
  }
});

test('launch roles are optional validated metadata rather than authority claims', () => {
  for (const role of [undefined, 'worker', 'coordinator']) {
    const snapshot = { type: 'sessions', groups, sessions: [{ ...session, role }], revision: 4 };
    assert.deepEqual(decodeServerMessage(snapshot), snapshot);
  }
  for (const role of [null, 'owner', true, {}]) {
    assert.throws(
      () =>
        decodeServerMessage({
          type: 'sessions',
          groups,
          sessions: [{ ...session, role }],
          revision: 4,
        }),
      /Invalid host message/,
    );
  }
});

const HOST_ID = 'c'.repeat(32);
const SESSION_ID = 'd'.repeat(32);
const programsFixture = [
  { id: 'shell', label: 'Terminal', available: true },
  { id: 'claude', label: 'Claude Code', available: true },
  { id: 'gemini', label: 'Gemini', available: false },
  { id: 'codex', label: 'Codex', available: true },
];
const inboxCapabilities = {
  type: 'capabilities',
  hostId: HOST_ID,
  workspace: 'C:\\projects',
  programs: programsFixture,
  pushNotifications: true,
  attentionInbox: true,
  decisions: true,
  jobPages: true,
};
const sessionItem = {
  kind: 'session',
  reason: 'question',
  title: 'Review',
  sessionId: SESSION_ID,
  program: 'claude',
  id: `session:${SESSION_ID}`,
  revision: 3,
  priority: 3,
  at: 1_792_783_619_000,
};
const decisionItem = {
  kind: 'decision',
  reason: 'decision',
  title: 'Release run',
  summary: 'Which branch should the worker use?',
  runId: 'run-1',
  decisionId: 'question-1',
  attemptId: 'attempt-1',
  audience: 'owner',
  expiresAt: 1_792_783_919_000,
  id: 'decision:run-1:question-1',
  revision: 1,
  priority: 3,
  at: 1_792_783_600_000,
};
const runItem = {
  kind: 'run',
  reason: 'validation',
  title: 'Nightly',
  runId: 'run-2',
  taskId: 'task-1',
  attemptId: 'attempt-2',
  id: 'run:run-2:attempt-2',
  revision: 2,
  priority: 2,
  at: 1_792_783_000_000,
};
const resultItem = {
  kind: 'result',
  reason: 'succeeded',
  title: '',
  jobId: 'job-1',
  occurrenceId: 'occurrence-1',
  runId: null,
  id: 'result:occurrence-1',
  revision: 2,
  priority: 1,
  at: 1_792_782_000_000,
};
const inboxPage = {
  type: 'attentionInbox',
  items: [sessionItem, decisionItem, runItem, resultItem],
  page: 0,
  limit: 16,
  nextPage: null,
  total: 4,
  requestId: 'inbox-1',
};
const pendingDecision = {
  id: 'question-1',
  runId: 'run-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
  question: 'Which branch should the worker use?',
  revision: 1,
  state: 'pending',
  audience: 'owner',
  askedBy: { kind: 'worker' },
  createdAt: 1_792_783_600_000,
  expiresAt: 1_792_783_919_000,
  answer: null,
  reason: null,
  resolvedAt: null,
  resolvedBy: null,
  inboxId: 'decision:run-1:question-1',
  run: { id: 'run-1', title: 'Release run', state: 'running' },
};

test('inbox, acknowledgement, decision and change events decode from host-shaped fixtures', () => {
  assert.deepEqual(decodeServerMessage(inboxPage), inboxPage);
  const receipts = {
    type: 'inboxAcknowledged',
    acknowledged: [{ id: decisionItem.id, revision: 1, acknowledgedAt: 1_792_783_700_000 }],
    requestId: 'ack-1',
  };
  assert.deepEqual(decodeServerMessage(receipts), receipts);
  const decisionsPage = {
    type: 'decisions',
    decisions: [pendingDecision],
    page: 0,
    nextPage: 1,
    total: 9,
    requestId: 'decisions-1',
  };
  assert.deepEqual(decodeServerMessage(decisionsPage), decisionsPage);
  const decided = {
    type: 'decided',
    run: { id: 'run-1' },
    task: { id: 'task-1' },
    attempt: { id: 'attempt-1' },
    decision: { ...pendingDecision, state: 'answered', answer: 'main', revision: 2 },
    cursor: 41,
    inboxId: 'decision:run-1:question-1',
    requestId: 'decide-1',
  };
  assert.deepEqual(decodeServerMessage(decided), decided);
  for (const changed of [
    { type: 'attentionInboxChanged', reason: 'decision', itemId: 'decision:run-1:question-1' },
    { type: 'attentionInboxChanged', reason: 'acknowledged' },
  ])
    assert.deepEqual(decodeServerMessage(changed), changed);
  const registered = {
    type: 'pushRegistered',
    enabled: true,
    kinds: ['decisionPending', 'resultReady'],
    requestId: 'push-1',
  };
  assert.deepEqual(decodeServerMessage(registered), registered);
});

test('malformed inbox and decision payloads are refused before reaching state', () => {
  const invalidItems = [
    { ...sessionItem, kind: 7 },
    { ...sessionItem, program: 7 },
    'session:x',
    { ...sessionItem, id: `decision:${SESSION_ID}` },
    { ...sessionItem, id: 'session:' },
    { ...sessionItem, priority: 0 },
    { ...sessionItem, priority: 4 },
    { ...sessionItem, revision: -1 },
    { ...sessionItem, at: 1.5 },
    { ...sessionItem, title: 7 },
    { ...sessionItem, reason: '' },
    { ...sessionItem, summary: null },
    { ...sessionItem, id: `session:${SESSION_ID}\n` },
    { ...sessionItem, id: `session:${'x'.repeat(200)}` },
  ];
  for (const item of invalidItems)
    assert.throws(
      () => decodeServerMessage({ ...inboxPage, items: [item] }),
      /Invalid host message/,
    );
  for (const page of [
    { ...inboxPage, items: [sessionItem, sessionItem] },
    { ...inboxPage, limit: 1 },
    { ...inboxPage, limit: 33 },
    { ...inboxPage, nextPage: 0 },
    { ...inboxPage, total: -1 },
    { ...inboxPage, items: undefined },
  ])
    assert.throws(() => decodeServerMessage(page), /Invalid host message/);
  for (const acknowledged of [[], [{ id: decisionItem.id, revision: 1 }], 'all'])
    assert.throws(
      () => decodeServerMessage({ type: 'inboxAcknowledged', acknowledged }),
      /Invalid host message/,
    );
  for (const decision of [
    { ...pendingDecision, inboxId: 'run:run-1:question-1' },
    { ...pendingDecision, revision: 0 },
    { ...pendingDecision, state: 7 },
    { ...pendingDecision, audience: 'everyone' },
    { ...pendingDecision, run: null },
  ])
    assert.throws(
      () =>
        decodeServerMessage({
          type: 'decisions',
          decisions: [decision],
          page: 0,
          nextPage: null,
          total: 1,
        }),
      /Invalid host message/,
    );
  for (const value of [
    { type: 'decided', decision: { id: 'question-1', revision: 2, state: 'answered' } },
    {
      type: 'decided',
      decision: { id: 'question-1', revision: 2, state: '' },
      inboxId: 'decision:run-1:question-1',
    },
    {
      type: 'decided',
      decision: { id: 'question-1', revision: 2, state: 'answered' },
      inboxId: 'session:x',
    },
    { type: 'attentionInboxChanged' },
    { type: 'attentionInboxChanged', reason: 'decision', itemId: 7 },
    { type: 'pushRegistered', enabled: true, kinds: 'decisionPending' },
  ])
    assert.throws(() => decodeServerMessage(value), /Invalid host message/);
});

test('unknown inbox kinds, programs and decision states are skipped item by item', () => {
  const futureItem = { ...sessionItem, kind: 'review', id: 'review:1' };
  const futureProgram = { ...sessionItem, program: 'aider' };
  const { program: _program, ...withoutProgram } = sessionItem;
  assert.deepEqual(
    decodeServerMessage({ ...inboxPage, items: [futureItem, futureProgram, decisionItem] }),
    { ...inboxPage, items: [withoutProgram, decisionItem], skipped: 1 },
  );
  const shellItem = { ...sessionItem, program: 'shell' };
  assert.deepEqual(decodeServerMessage({ ...inboxPage, items: [shellItem] }), {
    ...inboxPage,
    items: [withoutProgram],
  });
  assert.deepEqual(decodeServerMessage({ ...inboxPage, items: [futureItem, futureItem] }), {
    ...inboxPage,
    items: [],
    skipped: 2,
  });
  assert.throws(
    () =>
      decodeServerMessage({ ...inboxPage, items: [futureItem, { ...sessionItem, priority: 9 }] }),
    /Invalid host message/,
  );
  const decisionsPage = {
    type: 'decisions',
    decisions: [{ ...pendingDecision, state: 'superseded' }, pendingDecision],
    page: 0,
    nextPage: null,
    total: 2,
  };
  assert.deepEqual(decodeServerMessage(decisionsPage), {
    ...decisionsPage,
    decisions: [pendingDecision],
    skipped: 1,
  });
  const decided = {
    type: 'decided',
    decision: { id: 'question-1', revision: 2, state: 'superseded' },
    inboxId: 'decision:run-1:question-1',
  };
  assert.deepEqual(decodeServerMessage(decided), decided);
});

test('inbox capability flags are optional booleans and legacy capabilities still decode', () => {
  assert.deepEqual(decodeServerMessage(inboxCapabilities), inboxCapabilities);
  const { attentionInbox, decisions, jobPages, ...legacy } = inboxCapabilities;
  assert.equal(attentionInbox && decisions && jobPages, true);
  assert.deepEqual(decodeServerMessage(legacy), legacy);
  for (const flag of ['attentionInbox', 'decisions', 'jobPages'])
    assert.throws(
      () => decodeServerMessage({ ...inboxCapabilities, [flag]: 'yes' }),
      /Invalid host message/,
    );
});

class InboxFakeSocket {
  static latest: InboxFakeSocket;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number; reason: string }) => void;
  onerror?: () => void;
  constructor() {
    InboxFakeSocket.latest = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
}

const connectInboxPeer = () => {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = InboxFakeSocket as unknown as typeof WebSocket;
  const client = new HostClient();
  const events: HostEvent[] = [];
  client.subscribe(event => events.push(event));
  const key = new Uint8Array(32).fill(5);
  const challenge = 'b'.repeat(64);
  client.connect({ version: 1, url: 'ws://localhost:9999', key: Buffer.from(key).toString('hex') });
  const socket = InboxFakeSocket.latest;
  socket.onmessage?.({ data: JSON.stringify({ type: 'challenge', version: 1, challenge }) });
  const auth = decodeFrame(socket.sent[0]!, key, challenge, 'client-to-host', 1) as {
    clientNonce: string;
  };
  let hostSeq = 0;
  const receive = (payload: unknown) =>
    socket.onmessage?.({
      data: encodeFrame(payload, key, challenge, 'host-to-client', ++hostSeq, randomBytes),
    });
  receive({ type: 'connected', protocolVersion: 2, clientNonce: auth.clientNonce, clientId: 1 });
  const commands = () =>
    socket.sent.map(
      (frame, index) =>
        decodeFrame(frame, key, challenge, 'client-to-host', index + 1) as ClientCommand,
    );
  return {
    client,
    events,
    socket,
    receive,
    commands,
    cleanup: () => {
      client.disconnect();
      globalThis.WebSocket = originalWebSocket;
    },
  };
};

test('inbox commands stay unsent until the host advertises their capability flags', () => {
  const peer = connectInboxPeer();
  try {
    const { attentionInbox, decisions, jobPages, ...legacy } = inboxCapabilities;
    assert.equal(attentionInbox && decisions && jobPages, true);
    peer.receive(legacy);
    const before = peer.commands().length;
    assert.equal(peer.client.requestAttentionInbox(0), null);
    assert.equal(peer.client.acknowledgeInbox([{ id: decisionItem.id, revision: 1 }]), null);
    assert.equal(peer.client.requestDecisions(0), null);
    assert.equal(peer.client.decide('question-1', 'main'), null);
    peer.client.registerPush('ExponentPushToken[abcdefghijkl]', true, 'push-legacy');
    assert.equal(peer.commands().length, before + 1);
    assert.deepEqual(peer.commands().at(-1), {
      type: 'registerPush',
      token: 'ExponentPushToken[abcdefghijkl]',
      enabled: true,
      requestId: 'push-legacy',
    });
    assert.equal(
      peer.events.some(event => event.type === 'error'),
      false,
    );

    peer.receive({ ...legacy, attentionInbox: true });
    assert.equal(peer.client.requestAttentionInbox(0, 24, 'inbox-a'), 'inbox-a');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'attentionInbox',
      page: 0,
      limit: 24,
      requestId: 'inbox-a',
    });
    assert.equal(peer.client.requestDecisions(0), null);
    peer.client.registerPush('ExponentPushToken[abcdefghijkl]', true, 'push-results');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'registerPush',
      token: 'ExponentPushToken[abcdefghijkl]',
      enabled: true,
      requestId: 'push-results',
      kinds: ['resultReady'],
    });
    peer.receive({ ...legacy, decisions: true });
    peer.client.registerPush('ExponentPushToken[abcdefghijkl]', true, 'push-decisions');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'registerPush',
      token: 'ExponentPushToken[abcdefghijkl]',
      enabled: true,
      requestId: 'push-decisions',
      kinds: ['decisionPending'],
    });
    peer.receive({ ...legacy, attentionInbox: true });
    assert.equal(peer.client.acknowledgeInbox([]), null);
    assert.equal(
      peer.client.acknowledgeInbox(
        Array.from({ length: 33 }, (_, index) => ({ id: `session:${index}`, revision: 1 })),
      ),
      null,
    );
    assert.equal(
      peer.client.acknowledgeInbox([{ id: decisionItem.id, revision: 1 }], 'ack-a'),
      'ack-a',
    );
    assert.deepEqual(peer.commands().at(-1), {
      type: 'acknowledgeInbox',
      items: [{ id: decisionItem.id, revision: 1 }],
      requestId: 'ack-a',
    });

    peer.receive(inboxCapabilities);
    assert.equal(peer.client.requestDecisions(2, 'decisions-a'), 'decisions-a');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'decisions',
      page: 2,
      requestId: 'decisions-a',
    });
    assert.equal(peer.client.decide('question-1', 'main', '', 'decide-a'), 'decide-a');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'decide',
      decisionId: 'question-1',
      choice: 'main',
      requestId: 'decide-a',
    });
    peer.client.decide('question-1', 'main', 'Use the release notes', 'decide-b');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'decide',
      decisionId: 'question-1',
      choice: 'main',
      note: 'Use the release notes',
      requestId: 'decide-b',
    });
    peer.client.registerPush('ExponentPushToken[abcdefghijkl]', true, 'push-kinds');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'registerPush',
      token: 'ExponentPushToken[abcdefghijkl]',
      enabled: true,
      requestId: 'push-kinds',
      kinds: ['decisionPending', 'resultReady'],
    });
    peer.client.registerPush('ExponentPushToken[abcdefghijkl]', false, 'push-off');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'registerPush',
      token: 'ExponentPushToken[abcdefghijkl]',
      enabled: false,
      requestId: 'push-off',
    });

    peer.receive(inboxPage);
    assert.deepEqual(peer.events.at(-1), inboxPage);
    assert.equal(peer.client.isConnected, true);
  } finally {
    peer.cleanup();
  }
});

test('a reconnect forgets advertised inbox flags until the new host repeats them', () => {
  const peer = connectInboxPeer();
  try {
    peer.receive(inboxCapabilities);
    assert.equal(peer.client.inboxFeatures.decisions, true);
    peer.socket.close();
    assert.deepEqual(peer.client.inboxFeatures, {
      attentionInbox: false,
      decisions: false,
      jobPages: false,
      pushDevices: false,
    });
    assert.equal(peer.client.decide('question-1', 'main'), null);
    assert.equal(peer.client.requestAttentionInbox(0), null);
  } finally {
    peer.cleanup();
  }
});

test('an unknown inbox item kind inside a valid page keeps the connection open', () => {
  const peer = connectInboxPeer();
  try {
    peer.receive(inboxCapabilities);
    const futureItem = { ...sessionItem, kind: 'review', id: 'review:1' };
    peer.receive({ ...inboxPage, items: [futureItem, decisionItem] });
    assert.equal(peer.client.isConnected, true);
    assert.deepEqual(peer.events.at(-1), { ...inboxPage, items: [decisionItem], skipped: 1 });
    assert.equal(
      peer.events.some(event => event.type === 'error' || event.type === 'disconnected'),
      false,
    );
    const changed = { type: 'attentionInboxChanged', reason: 'decision' };
    peer.receive(changed);
    assert.deepEqual(peer.events.at(-1), changed);
    assert.equal(peer.client.isConnected, true);
  } finally {
    peer.cleanup();
  }
});

test('unknown inbox event types still disconnect a legacy-shaped session', () => {
  const peer = connectInboxPeer();
  try {
    peer.receive({ type: 'inboxSummary', items: [] });
    assert.equal(peer.client.isConnected, false);
    assert.ok(peer.events.some(event => event.type === 'disconnected'));
  } finally {
    peer.cleanup();
  }
});

test('inbox lists group by priority, hide acknowledged revisions and roll back refusals', () => {
  const items = inboxPage.items as InboxItem[];
  const sections = groupInboxItems(items);
  assert.deepEqual(
    sections.map(section => [section.priority, section.items.map(item => item.kind)]),
    [
      [3, ['session', 'decision']],
      [2, ['run']],
      [1, ['result']],
    ],
  );
  const decision = items[1]!;
  const optimistic = withoutItems(items, [decision]);
  assert.equal(
    optimistic.some(item => item.id === decision.id),
    false,
  );
  const hidden = new Set([markKey(decision)]);
  assert.equal(
    mergeInboxPage(optimistic, items, true, hidden).some(item => item.id === decision.id),
    false,
  );
  const newer = { ...decision, revision: 2 };
  assert.ok(mergeInboxPage(optimistic, [newer], true, hidden).includes(newer));
  assert.deepEqual(
    restoreItems(optimistic, [decision]).map(item => item.id),
    items.map(item => item.id),
  );
  assert.deepEqual(restoreItems([newer], [decision]), [newer]);
  const appended = mergeInboxPage(items.slice(0, 2), items.slice(1), false, new Set());
  assert.deepEqual(
    appended.map(item => item.id),
    items.map(item => item.id),
  );
  const marks = new Set<string>();
  for (let index = 0; index < MAX_HIDDEN_MARKS + 10; index += 1)
    rememberMark(marks, `session:${index}@1`);
  assert.equal(marks.size, MAX_HIDDEN_MARKS);
  assert.equal(marks.has('session:0@1'), false);
  assert.equal(marks.has(`session:${MAX_HIDDEN_MARKS + 9}@1`), true);
  assert.equal(refreshLimit(0), 16);
  assert.equal(refreshLimit(20), 20);
  assert.equal(refreshLimit(90), 32);
});

test('stale decision answers are explained and never resubmitted before a fresh list', () => {
  const decision = pendingDecision as PendingDecision;
  assert.match(decisionRefusal('decision_resolved') ?? '', /already answered or canceled/);
  assert.match(decisionRefusal('decision_expired') ?? '', /expired before/);
  assert.equal(decisionRefusal('busy'), null);
  assert.equal(decisionRefusal(undefined), null);
  const key = submissionKey(decision);
  const sending = new Map([[key, 'sending' as const]]);
  assert.equal(canSubmitDecision(new Map(), decision), true);
  assert.equal(canSubmitDecision(sending, decision), false);
  assert.equal(canSubmitDecision(new Map(), { ...decision, state: 'expired' }), false);
  const unknown = markSubmissionsUnknown(sending, [key]);
  assert.equal(unknown.get(key), 'unknown');
  assert.equal(canSubmitDecision(unknown, decision), false);
  assert.equal(canSubmitDecision(unknown, { ...decision, revision: 2 }), true);
  assert.equal(settleUnknownSubmissions(unknown).size, 0);
  assert.equal(settleUnknownSubmissions(sending).get(key), 'sending');
  assert.deepEqual(normalizeDecisionAnswer('  main ', '  '), { choice: 'main', note: undefined });
  assert.deepEqual(normalizeDecisionAnswer('main', ' ship it '), {
    choice: 'main',
    note: 'ship it',
  });
  assert.equal(normalizeDecisionAnswer('   ', 'note'), null);
  assert.equal(normalizeDecisionAnswer('x'.repeat(2001), ''), null);
  assert.deepEqual(mergeDecisionPage([decision], [{ ...decision, state: 'answered' }], true), []);
});

test('metadata-only inbox pushes open the inbox and session pushes keep their target', () => {
  const inbox = { hostId: HOST_ID, kind: 'decisionPending', itemId: 'decision:run-1:question-1' };
  assert.deepEqual(parseNotificationTarget(inbox), { type: 'inbox', target: inbox });
  assert.deepEqual(
    parseNotificationTarget({ hostId: HOST_ID, kind: 'resultReady', itemId: 'result:occ-1' }),
    { type: 'inbox', target: { hostId: HOST_ID, kind: 'resultReady', itemId: 'result:occ-1' } },
  );
  const session = { hostId: HOST_ID, sessionId: SESSION_ID, sequence: 4 };
  assert.deepEqual(parseNotificationTarget(session), { type: 'session', target: session });
  for (const value of [
    { ...inbox, kind: 'sessionAttention' },
    { ...inbox, itemId: '../../settings' },
    { ...inbox, itemId: 'decision:' },
    { ...inbox, itemId: 'decision:run 1' },
    { ...inbox, hostId: 'https://malicious.example' },
    null,
    'decision:run-1:question-1',
  ])
    assert.equal(parseNotificationTarget(value), null);
});

test('list ages and decision deadlines accept millisecond and second host timestamps', () => {
  const now = 1_792_783_619_000;
  assert.equal(formatAge(now - 10_000, now), 'just now');
  assert.equal(formatAge(now - 5 * 60_000, now), '5 min ago');
  assert.equal(formatAge(Math.floor((now - 3 * 3_600_000) / 1000), now), '3 h ago');
  assert.equal(formatAge(now - 2 * 86_400_000, now), '2 d ago');
  assert.equal(formatRemaining(now + 10 * 60_000, now), 'in 10 min');
  assert.equal(formatRemaining(now + 5_000, now), 'in under a minute');
  assert.equal(formatRemaining(now - 1, now), 'now');
  const inSeconds = (at: number) => Math.floor(at / 1000);
  assert.equal(formatRemaining(inSeconds(now + 2 * 3_600_000), now), 'in 2 h');
  assert.equal(hasElapsed(now + 60_000, now), false);
  assert.equal(hasElapsed(inSeconds(now + 60_000), now), false);
  assert.equal(hasElapsed(now, now), true);
  assert.equal(hasElapsed(inSeconds(now - 60_000), now), true);
});

test('inbox fixtures used by the client match the published host schema', () => {
  assertInboxFixtures(cliValidator());
});

function assertInboxFixtures(validate: ReturnType<Ajv['compile']>) {
  const envelope = (data: Record<string, unknown>) => ({ schemaVersion: 1, ok: true, data });
  const { requestId: _inboxRequest, ...page } = inboxPage;
  assert.equal(validate(envelope(page)), true, JSON.stringify(validate.errors));
  const decisionsPage = {
    type: 'decisions',
    decisions: [pendingDecision],
    page: 0,
    nextPage: null,
    total: 1,
  };
  assert.equal(validate(envelope(decisionsPage)), true, JSON.stringify(validate.errors));
  const receipts = {
    type: 'inboxAcknowledged',
    acknowledged: [{ id: decisionItem.id, revision: 1, acknowledgedAt: 1_792_783_700_000 }],
  };
  assert.equal(validate(envelope(receipts)), true, JSON.stringify(validate.errors));
  const decided = {
    type: 'decided',
    run: { id: 'run-1' },
    decision: { ...pendingDecision, state: 'answered', answer: 'main', revision: 2 },
    cursor: 41,
    inboxId: 'decision:run-1:question-1',
  };
  assert.equal(validate(envelope(decided)), true, JSON.stringify(validate.errors));
}

test('real host inbox and decision replies decode and match the published host schema', () => {
  const validate = new Ajv().compile(
    JSON.parse(readFileSync(new URL('../docs/harness-cli.schema.json', import.meta.url), 'utf8')),
  );
  const replies = JSON.parse(
    readFileSync(new URL('./fixtures/host-inbox-replies.json', import.meta.url), 'utf8'),
  ) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(replies).sort(), [
    'attentionInbox',
    'decided',
    'decisions',
    'inboxAcknowledged',
  ]);
  for (const [type, reply] of Object.entries(replies)) {
    assert.equal(reply.type, type);
    assert.equal(
      validate({ schemaVersion: 1, ok: true, data: reply }),
      true,
      `${type}: ${JSON.stringify(validate.errors)}`,
    );
    const message = { ...reply, requestId: `golden-${type}` };
    assert.deepEqual(decodeServerMessage(message), message);
  }
});

const hookFreshness = {
  source: 'hook',
  observedAt: 1_792_783_000_000,
  ageMs: 2_000,
  stale: false,
  boundMs: 4000,
  lastKnown: null,
} as const;
const lostFreshness = {
  source: 'journal',
  observedAt: 1_792_783_000_000,
  ageMs: 754_000,
  stale: true,
  boundMs: 4000,
  lastKnown: { state: 'working', observedAt: 1_792_783_000_000 },
} as const;

test('session freshness decodes additively and rejects guessed live states after a disconnect', () => {
  const snapshot = { type: 'sessions', groups, sessions: [session], revision: 4 };
  const status = { state: 'working', source: 'screen', evidence: 'hook', updatedAt: 1 };
  for (const accepted of [
    status,
    { ...status, freshness: hookFreshness },
    { ...status, state: 'unknown', freshness: lostFreshness },
    {
      state: 'done',
      source: 'process',
      updatedAt: 2,
      freshness: { ...hookFreshness, source: 'process', boundMs: null },
    },
    {
      state: 'idle',
      source: 'screen',
      updatedAt: 3,
      freshness: { ...hookFreshness, source: 'unknown', boundMs: null },
    },
  ]) {
    const message = { ...snapshot, sessions: [{ ...session, status: accepted }] };
    assert.deepEqual(decodeServerMessage(message), message);
  }
  for (const freshness of [
    { ...lostFreshness, stale: 'yes' },
    { ...hookFreshness, source: 'guess' },
    { ...hookFreshness, stale: true },
    { ...hookFreshness, ageMs: -1 },
    { ...hookFreshness, observedAt: 'now' },
    { ...hookFreshness, boundMs: undefined },
    { ...lostFreshness, lastKnown: { state: 'succeeded', observedAt: 1 } },
    { ...lostFreshness, source: 'hook' },
    null,
  ])
    assert.throws(
      () =>
        decodeServerMessage({
          ...snapshot,
          sessions: [{ ...session, status: { ...status, state: 'unknown', freshness } }],
        }),
      /Invalid host message/,
    );
  assert.throws(
    () =>
      decodeServerMessage({
        ...snapshot,
        sessions: [{ ...session, status: { ...status, freshness: lostFreshness } }],
      }),
    /Invalid host message/,
    'a disconnected projection cannot keep a live state',
  );
});

test('session freshness feeds the shared badge clock and stays absent for legacy hosts', () => {
  const receivedAt = 1_800_000_000_000;
  const fresh = sessionStateFreshness(hookFreshness, receivedAt);
  assert.deepEqual(fresh, { observedAt: receivedAt - 2_000, stale: false, lastKnown: null });
  assert.equal(formatAge(fresh!.observedAt, receivedAt), 'just now');
  assert.equal(sessionLastKnownLabel(fresh), undefined);
  const lost = sessionStateFreshness(lostFreshness, receivedAt);
  assert.deepEqual(lost, { observedAt: receivedAt - 754_000, stale: true, lastKnown: 'working' });
  assert.equal(formatAge(lost!.observedAt, receivedAt), '12 min ago');
  assert.equal(sessionLastKnownLabel(lost), 'Last known working');
  assert.equal(
    sessionStateFreshness({ ...hookFreshness, source: 'unknown', boundMs: null }, receivedAt),
    undefined,
  );
  assert.equal(sessionStateFreshness(undefined, receivedAt), undefined);
  assert.equal(sessionLastKnownLabel(undefined), undefined);
});

test('a hibernated session decodes as a stopped record with last-known freshness', () => {
  const hibernation = {
    state: 'hibernated',
    hibernatedAt: 1_792_785_000_000,
    conversationId: '0f8fad5b-d9cb-469f-a165-70867728950e',
    trigger: 'owner',
    lastResumeFailure: null,
  };
  const hibernated = {
    ...session,
    running: false,
    readiness: { phase: 'exited', initialized: true, reason: 'Hibernated' },
    status: {
      state: 'unknown',
      source: 'screen',
      evidence: 'hook',
      updatedAt: 1,
      freshness: { ...lostFreshness, lastKnown: { state: 'idle', observedAt: 1 } },
    },
    hibernation,
  };
  const snapshot = { type: 'sessions', groups, sessions: [hibernated], revision: 4 };
  const validate = cliValidator();
  assert.equal(
    validate({ schemaVersion: 1, ok: true, data: snapshot }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.deepEqual(decodeServerMessage(snapshot), snapshot);
  assert.equal(sessionReadinessLabel(hibernated.readiness, true), 'Hibernated');
  assert.equal(sessionReadinessLabel(hibernated.readiness, false), undefined);
  for (const invalid of [
    { ...hibernated, running: true },
    { ...hibernated, hibernation: { ...hibernation, state: 'sleeping' } },
    { ...hibernated, hibernation: { ...hibernation, trigger: 'timer' } },
    { ...hibernated, hibernation: { ...hibernation, hibernatedAt: -1 } },
    { ...hibernated, hibernation: { ...hibernation, lastResumeFailure: 7 } },
  ])
    assert.throws(
      () => decodeServerMessage({ ...snapshot, sessions: [invalid] }),
      /Invalid host message/,
    );
});

test('the client opts into session freshness and accepts the advertised flag', () => {
  const peer = connectInboxPeer();
  try {
    assert.deepEqual(
      peer.commands().find(command => command.type === 'getCapabilities'),
      { type: 'getCapabilities', sessionFreshness: true },
    );
    const capabilities = { ...inboxCapabilities, sessionFreshness: true };
    assert.deepEqual(decodeServerMessage(capabilities), capabilities);
    assert.throws(
      () => decodeServerMessage({ ...inboxCapabilities, sessionFreshness: 'yes' }),
      /Invalid host message/,
    );
  } finally {
    peer.cleanup();
  }
});

test('host-captured domain event records match the generated event schema', () => {
  const validate = new Ajv().compile(
    JSON.parse(
      readFileSync(new URL('../docs/harness-events.schema.json', import.meta.url), 'utf8'),
    ),
  );
  const records = readFileSync(
    new URL('../crates/nesvo-wire/tests/fixtures/events.jsonl', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal(validate(record), true, `${record.kind}: ${JSON.stringify(validate.errors)}`);
  }
  const [first] = records;
  assert.ok(first);
  assert.equal(validate({ ...first, kind: 'host.unknown' }), false);
  assert.equal(validate({ ...first, payload: { ...first.payload, extra: true } }), false);
  assert.equal(validate({ ...first, sequence: -1 }), false);
});

const cronSchedule = { kind: 'cron', expression: '0 2 * * *', timeZone: 'Europe/Warsaw' } as const;
const jobDefinition = {
  id: 'job-nightly',
  title: 'Nightly review',
  revision: 3,
  enabled: true,
  nextDueAt: 1_792_800_000_000,
  createdAt: 1_792_700_000_000,
  schedule: cronSchedule,
  calendarState: 'ready',
  calendarError: null,
} as const;
const externalJob = {
  id: 'job-webhook',
  title: 'Release notes',
  revision: 1,
  enabled: false,
  nextDueAt: null,
  createdAt: 1_792_700_100_000,
  schedule: { kind: 'external' },
  calendarState: 'exhausted',
  calendarError: null,
} as const;
const jobSpec = {
  title: 'Nightly review',
  instruction: 'Summarize the current Git changes without editing files.',
  profile: {
    program: 'claude',
    workspace: 'shared',
    harness: true,
    allowedNesvoTools: ['nesvo_get_current_task', 'nesvo_report_task_result'],
  },
  schedule: cronSchedule,
  retry: { on: 'launchNoEffect', maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 10000 },
  misfire: 'catchUp',
  graceMs: 60000,
  overlap: 'skip',
  maxElapsedMs: 300000,
};
const retryingOccurrence = {
  id: 'occurrence-2',
  jobId: 'job-nightly',
  jobRevision: 3,
  trigger: 'schedule',
  dueAt: 1_792_713_600_000,
  createdAt: 1_792_713_600_100,
  state: 'retryWaiting',
  reason: 'retry_backoff',
  runId: 'run-9',
  startedAt: 1_792_713_601_000,
  finishedAt: null,
  coalescedFromAt: null,
  precheck: null,
  cancellation: null,
  executionTimeout: null,
  launchReconciliation: null,
  launchResolution: null,
  jobAttemptId: 'job-attempt-1',
  jobAttemptOrdinal: 1,
  retry: {
    jobAttemptId: 'job-attempt-1',
    attemptId: null,
    launchReceiptId: 'receipt-1',
    decidedAt: 1_792_713_602_000,
    notBefore: 1_792_713_603_000,
    nextOrdinal: 2,
    class: 'noEffect',
  },
  attemptId: 'attempt-1',
  sessionId: 'session-1',
  launchReceiptId: 'receipt-1',
} as const;
const finishedOccurrence = {
  ...retryingOccurrence,
  id: 'occurrence-1',
  trigger: 'manual',
  dueAt: 1_792_627_200_000,
  createdAt: 1_792_627_200_100,
  state: 'succeeded',
  reason: null,
  runId: 'run-8',
  finishedAt: 1_792_627_500_000,
  jobAttemptId: 'job-attempt-0',
  retry: null,
} as const;
const jobListWire = {
  type: 'workflow',
  jobs: [jobDefinition, externalJob],
  nextOffset: 16,
  page: 0,
  nextPage: 1,
  requestId: 'jobs-1',
};
const jobDetailWire = {
  type: 'workflow',
  job: { ...jobDefinition, spec: jobSpec },
  requestId: 'job-1',
};
const jobHistoryWire = {
  type: 'workflow',
  occurrences: [retryingOccurrence, finishedOccurrence],
  nextOffset: null,
  page: 0,
  nextPage: null,
  requestId: 'history-1',
};

test('job list, detail and history fixtures match the published host schema', () => {
  const validate = new Ajv().compile(
    JSON.parse(readFileSync(new URL('../docs/harness-cli.schema.json', import.meta.url), 'utf8')),
  );
  for (const wire of [jobListWire, jobDetailWire, jobHistoryWire]) {
    const { requestId: _requestId, ...data } = wire;
    assert.equal(
      validate({ schemaVersion: 1, ok: true, data }),
      true,
      JSON.stringify(validate.errors),
    );
  }
});

test('workflow job replies decode into list, detail and history events', () => {
  assert.deepEqual(decodeServerMessage(jobListWire), {
    type: 'jobPage',
    jobs: [jobDefinition, externalJob],
    page: 0,
    nextPage: 1,
    requestId: 'jobs-1',
  });
  assert.deepEqual(decodeServerMessage(jobDetailWire), {
    type: 'jobDetail',
    job: { ...jobDefinition, spec: jobSpec },
    requestId: 'job-1',
  });
  assert.deepEqual(decodeServerMessage(jobHistoryWire), {
    type: 'jobHistory',
    occurrences: [retryingOccurrence, finishedOccurrence],
    page: 0,
    nextPage: null,
    requestId: 'history-1',
  });
  const {
    jobAttemptId: _id,
    jobAttemptOrdinal: _ordinal,
    retry: _retry,
    ...legacy
  } = finishedOccurrence;
  assert.deepEqual(
    decodeServerMessage({ type: 'workflow', occurrences: [legacy], page: 1, nextPage: null }),
    {
      type: 'jobHistory',
      occurrences: [{ ...legacy, jobAttemptId: null, jobAttemptOrdinal: null, retry: null }],
      page: 1,
      nextPage: null,
    },
  );
});

test('unknown job schedules, states and retry classes stay tolerant item by item', () => {
  const futureJob = {
    ...jobDefinition,
    id: 'job-interval',
    schedule: { kind: 'interval', everyMs: 60000 },
    calendarState: 'paused',
  };
  assert.deepEqual(decodeServerMessage({ ...jobListWire, jobs: [futureJob, externalJob] }), {
    type: 'jobPage',
    jobs: [{ ...futureJob, schedule: null, calendarState: null }, externalJob],
    page: 0,
    nextPage: 1,
    requestId: 'jobs-1',
  });
  const futureOccurrence = { ...finishedOccurrence, id: 'occurrence-0', state: 'archived' };
  const futureClass = {
    ...retryingOccurrence,
    retry: { ...retryingOccurrence.retry, class: 'partialEffect' },
  };
  const { class: _class, ...classless } = retryingOccurrence.retry;
  assert.deepEqual(
    decodeServerMessage({ ...jobHistoryWire, occurrences: [futureClass, futureOccurrence] }),
    {
      type: 'jobHistory',
      occurrences: [{ ...retryingOccurrence, retry: classless }],
      page: 0,
      nextPage: null,
      skipped: 1,
      requestId: 'history-1',
    },
  );
  const { program: _program, ...profile } = jobSpec.profile;
  const futureProgram = { ...jobSpec, profile: { ...jobSpec.profile, program: 'aider' } };
  assert.deepEqual(
    decodeServerMessage({ ...jobDetailWire, job: { ...jobDefinition, spec: futureProgram } }),
    {
      type: 'jobDetail',
      job: { ...jobDefinition, spec: { ...jobSpec, profile } },
      requestId: 'job-1',
    },
  );
  const peer = connectInboxPeer();
  try {
    peer.receive(inboxCapabilities);
    peer.receive({ ...jobHistoryWire, occurrences: [futureOccurrence] });
    assert.equal(peer.client.isConnected, true);
    assert.deepEqual(peer.events.at(-1), {
      type: 'jobHistory',
      occurrences: [],
      page: 0,
      nextPage: null,
      skipped: 1,
      requestId: 'history-1',
    });
  } finally {
    peer.cleanup();
  }
});

test('malformed job replies are refused before reaching state', () => {
  for (const job of [
    { ...jobDefinition, revision: 0 },
    { ...jobDefinition, title: 'x'.repeat(81) },
    { ...jobDefinition, enabled: 'yes' },
    { ...jobDefinition, nextDueAt: -1 },
    { ...jobDefinition, schedule: { kind: 'cron', expression: '* * * * *' } },
    { ...jobDefinition, schedule: 'daily' },
    { ...jobDefinition, calendarState: 7 },
    { ...jobDefinition, calendarError: { code: 'schedule_too_dense' } },
  ])
    assert.throws(
      () => decodeServerMessage({ ...jobListWire, jobs: [job] }),
      /Invalid host message/,
    );
  const manyJobs = Array.from({ length: 17 }, (_, index) => ({
    ...jobDefinition,
    id: `job-${index}`,
  }));
  const withSpec = (spec: Record<string, unknown>) => ({
    ...jobDetailWire,
    job: { ...jobDefinition, spec: { ...jobSpec, ...spec } },
  });
  const withOccurrence = (occurrence: Record<string, unknown>) => ({
    ...jobHistoryWire,
    occurrences: [{ ...finishedOccurrence, ...occurrence }],
  });
  for (const reply of [
    { ...jobListWire, jobs: manyJobs },
    { ...jobListWire, jobs: [jobDefinition, jobDefinition] },
    { ...jobListWire, page: 257 },
    { ...jobListWire, nextPage: 0 },
    { ...jobListWire, page: undefined },
    { ...jobHistoryWire, page: 513 },
    { ...jobHistoryWire, occurrences: [finishedOccurrence, finishedOccurrence] },
    { ...jobHistoryWire, occurrences: Array(9).fill(finishedOccurrence) },
    withOccurrence({ reason: 7 }),
    withOccurrence({ jobAttemptOrdinal: 0 }),
    withOccurrence({ retry: { class: 'noEffect' } }),
    withOccurrence({ state: 7 }),
    { ...jobDetailWire, job: jobDefinition },
    withSpec({ instruction: 7 }),
    withSpec({ retry: { on: 'launchNoEffect' } }),
    { type: 'workflow', run: { id: 'run-1' } },
  ])
    assert.throws(() => decodeServerMessage(reply), /Invalid host message/);
});

test('job reads stay unsent until the host advertises job pages and carry the page', () => {
  const peer = connectInboxPeer();
  try {
    const { jobPages: _jobPages, ...legacy } = inboxCapabilities;
    peer.receive(legacy);
    const before = peer.commands().length;
    assert.equal(peer.client.requestJobs(0), null);
    assert.equal(peer.client.requestJob('job-nightly'), null);
    assert.equal(peer.client.requestJobHistory('job-nightly', 0), null);
    assert.equal(peer.commands().length, before);
    peer.receive(inboxCapabilities);
    assert.equal(peer.client.requestJobs(1, 'jobs-a'), 'jobs-a');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'workflow',
      request: { action: 'jobs', request: { action: 'list', page: 1 } },
      requestId: 'jobs-a',
    });
    assert.equal(peer.client.requestJob('job-nightly', 'job-a'), 'job-a');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'workflow',
      request: { action: 'jobs', request: { action: 'get', jobId: 'job-nightly' } },
      requestId: 'job-a',
    });
    assert.equal(peer.client.requestJobHistory('job-nightly', 2, 'history-a'), 'history-a');
    assert.deepEqual(peer.commands().at(-1), {
      type: 'workflow',
      request: { action: 'jobs', request: { action: 'history', jobId: 'job-nightly', page: 2 } },
      requestId: 'history-a',
    });
    const sent = peer.commands().length;
    for (const refused of [
      peer.client.requestJobs(-1),
      peer.client.requestJobs(257),
      peer.client.requestJobs(1.5),
      peer.client.requestJob(''),
      peer.client.requestJobHistory('job-nightly', 513),
      peer.client.requestJobHistory('', 0),
    ])
      assert.equal(refused, null);
    assert.equal(peer.commands().length, sent);
    peer.receive(jobListWire);
    assert.equal(peer.events.at(-1)?.type, 'jobPage');
    peer.socket.close();
    assert.equal(peer.client.requestJobs(0), null);
  } finally {
    peer.cleanup();
  }
});

test('job pages merge by id within the loaded bound and stop paging at it', () => {
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `job-${from + index}` }));
  assert.deepEqual(mergePage(page(0, 2), page(5, 1), true, MAX_LOADED_JOBS), page(5, 1));
  assert.deepEqual(mergePage(page(0, 2), page(1, 2), false, MAX_LOADED_JOBS), page(0, 3));
  const full = mergePage(page(0, 60), page(60, 16), false, MAX_LOADED_JOBS);
  assert.equal(full.length, MAX_LOADED_JOBS);
  assert.equal(nextLoadablePage(5, full.length, MAX_LOADED_JOBS), null);
  assert.equal(nextLoadablePage(2, 32, MAX_LOADED_JOBS), 2);
  assert.equal(nextLoadablePage(null, 8, MAX_LOADED_JOBS), null);
  const twoPages = applyPage(
    applyPage(
      { items: [], nextPage: null, lastPage: 0 },
      { items: page(0, 2), page: 0, nextPage: 1 },
      true,
      MAX_LOADED_JOBS,
    ),
    { items: page(2, 1), page: 1, nextPage: null },
    false,
    MAX_LOADED_JOBS,
  );
  assert.deepEqual(twoPages, { items: page(0, 3), nextPage: null, lastPage: 1 });
  const revisited = applyPage(
    twoPages,
    { items: [{ id: 'job-0' }, { id: 'job-1' }], page: 0, nextPage: 1 },
    false,
    MAX_LOADED_JOBS,
  );
  assert.deepEqual(revisited.items.map(item => item.id).sort(), ['job-0', 'job-1', 'job-2']);
  assert.equal(revisited.nextPage, null, 'Revisiting the first page keeps later pages loaded');
  assert.equal(revisited.lastPage, 1);
});

test('job detail labels name the schedule, attempts and retry class', () => {
  assert.equal(scheduleLabel(cronSchedule), 'Cron 0 2 * * * (Europe/Warsaw)');
  assert.equal(scheduleLabel({ kind: 'external' }), 'External trigger only');
  assert.equal(scheduleLabel(null), 'This schedule needs a newer nesvo app');
  assert.equal(formatInstant(1_792_713_600_000), '2026-10-23 00:00 UTC');
  const decoded = decodeServerMessage(jobHistoryWire) as Extract<HostEvent, { type: 'jobHistory' }>;
  const [retrying, finished] = decoded.occurrences;
  assert.ok(retrying && finished);
  assert.equal(attemptsLabel(retrying, jobSpec.retry), 'Attempt 1 of 3');
  assert.equal(
    attemptsLabel({ ...finished, jobAttemptOrdinal: null }, undefined),
    'No dispatch yet · up to 1',
  );
  assert.match(retryClassLabel(retrying, jobSpec.retry), /^No effect/);
  assert.equal(retryClassLabel(finished, jobSpec.retry), 'No retry decision');
  assert.equal(retryClassLabel(finished, undefined), 'No retry policy');
  assert.equal(jobStateLabel(jobDefinition), 'Next start 2026-10-24 00:00 UTC');
  assert.equal(jobStateLabel(externalJob), 'Paused');
});

test('child sessions follow their parent and keep the parent group section', () => {
  const node = (id: string, parentSessionId?: string | null, groupId: string | null = null) => ({
    id,
    parentSessionId,
    groupId,
  });
  const rows = sessionLineageRows([
    node('worker-b', 'coordinator', 'mobile'),
    node('shell'),
    node('coordinator', null, 'server'),
    node('reviewer', 'worker-b'),
    node('orphan', 'closed-parent', 'mobile'),
  ]);
  assert.deepEqual(
    rows.map(row => [row.session.id, row.root.id, row.depth]),
    [
      ['shell', 'shell', 0],
      ['coordinator', 'coordinator', 0],
      ['worker-b', 'coordinator', 1],
      ['reviewer', 'coordinator', 2],
      ['orphan', 'orphan', 0],
    ],
  );
  const chain = Array.from({ length: 6 }, (_, index) =>
    node(`level-${index}`, index === 0 ? null : `level-${index - 1}`),
  );
  assert.equal(Math.max(...sessionLineageRows(chain).map(row => row.depth)), MAX_LINEAGE_DEPTH);
  const cycle = sessionLineageRows([node('a', 'b'), node('b', 'a'), node('self', 'self')]);
  assert.deepEqual(
    cycle.map(row => [row.session.id, row.depth]),
    [
      ['self', 0],
      ['a', 0],
      ['b', 1],
    ],
  );
});

const pushDevicesWire = {
  type: 'pushDevices',
  devices: [
    { device: 'ab12cd', kinds: [] },
    { device: '_9xY7z', kinds: ['decisionPending', 'resultReady'] },
  ],
  requestId: 'devices-1',
};

test('push device replies decode with known kinds and drop unknown kinds one by one', () => {
  assert.deepEqual(decodeServerMessage(pushDevicesWire), pushDevicesWire);
  assert.deepEqual(
    decodeServerMessage({
      ...pushDevicesWire,
      devices: [{ device: 'ab12cd', kinds: ['weeklyDigest', 'resultReady'] }],
    }),
    { ...pushDevicesWire, devices: [{ device: 'ab12cd', kinds: ['resultReady'] }] },
  );
  for (const devices of [
    'all',
    [{ device: '', kinds: [] }],
    [{ device: 'x'.repeat(17), kinds: [] }],
    [{ device: 'ab12cd' }],
    [{ device: 'ab12cd', kinds: 'resultReady' }],
    [{ device: 'ab12cd', kinds: Array(9).fill('resultReady') }],
    Array(9).fill({ device: 'ab12cd', kinds: [] }),
  ])
    assert.throws(
      () => decodeServerMessage({ ...pushDevicesWire, devices }),
      /Invalid host message/,
    );
  assert.throws(
    () => decodeServerMessage({ ...inboxCapabilities, pushDevices: 'yes' }),
    /Invalid host message/,
  );
});

test('push device listing stays unsent until the host advertises it', () => {
  const peer = connectInboxPeer();
  try {
    peer.receive(inboxCapabilities);
    const before = peer.commands().length;
    assert.equal(peer.client.requestPushDevices(), null);
    assert.equal(peer.commands().length, before);
    peer.receive({ ...inboxCapabilities, pushDevices: true });
    assert.equal(peer.client.inboxFeatures.pushDevices, true);
    assert.equal(peer.client.requestPushDevices('devices-a'), 'devices-a');
    assert.deepEqual(peer.commands().at(-1), { type: 'pushDevices', requestId: 'devices-a' });
    peer.receive(pushDevicesWire);
    assert.deepEqual(peer.events.at(-1), pushDevicesWire);
    assert.equal(peer.client.isConnected, true);
    peer.socket.close();
    assert.equal(peer.client.requestPushDevices(), null);
  } finally {
    peer.cleanup();
  }
});
