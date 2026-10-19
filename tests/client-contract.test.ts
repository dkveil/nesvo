import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flattenGroups,
  groupDescendants,
  groupPath,
  validGroupName,
} from '../apps/mobile/src/entities/group/model/groups';
import {
  sessionReadinessLabel,
  statusNeedsAttention,
} from '../apps/mobile/src/entities/session/model/status-presentation';
import { decodeServerMessage } from '../apps/mobile/src/shared/api/host/messages';
import type { SessionGroup } from '../apps/mobile/src/shared/api/host/types';
import { parseTarget } from '../apps/mobile/src/shared/notifications/target';

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
  assert.equal(sessionReadinessLabel(readiness), 'Uruchamianie');
  assert.equal(sessionReadinessLabel({ ...readiness, phase: 'timedOut' }), 'Błąd startu');
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
  assert.equal(groupPath(groups, null), 'Bez grupy');
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
