import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeServerMessage } from '../src/connection/messages';
import type { SessionGroup } from '../src/connection/types';
import { flattenGroups, groupDescendants, groupPath, validGroupName } from '../src/groups';

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
      groups: groups.map((group) =>
        group.id === 'root' ? { ...group, parentId: 'grandchild' } : group,
      ),
    },
    { ...snapshot, sessions: [{ ...session, groupId: 'missing' }] },
    { ...snapshot, sessions: [{ ...session, cols: 0 }] },
    { ...snapshot, sessions: [{ ...session, running: 'yes' }] },
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
