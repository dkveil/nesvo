import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flattenGroups,
  groupDescendants,
  groupPath,
  validGroupName,
} from '../apps/mobile/src/entities/group/model/groups';
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
