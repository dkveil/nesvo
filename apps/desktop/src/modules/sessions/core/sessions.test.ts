import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildSessionRows } from './build-session-rows';
import { parseSnapshot } from './parse-snapshot';

const session = (overrides: Record<string, unknown>) => ({
  id: 's1',
  name: 'main',
  cwd: '/work',
  createdAt: '2026-11-06T10:00:00Z',
  cols: 80,
  rows: 24,
  running: true,
  controllerId: null,
  groupId: null,
  program: 'claude',
  ...overrides,
});

const snapshot = (sessions: unknown[], groups: unknown[] = []) => ({
  type: 'sessions',
  sessions,
  groups,
  revision: 3,
});

describe('parseSnapshot', () => {
  it('accepts a well formed snapshot', () => {
    assert.equal(parseSnapshot(snapshot([session({})]))?.revision, 3);
  });

  it('rejects other message types and malformed sessions', () => {
    assert.equal(parseSnapshot({ type: 'created' }), null);
    assert.equal(parseSnapshot(snapshot([{ id: 's1' }])), null);
    assert.equal(
      parseSnapshot(snapshot([], [{ id: 'g', name: 'g', order: 'x', parentId: null }])),
      null,
    );
    assert.equal(parseSnapshot(null), null);
  });
});

describe('buildSessionRows', () => {
  it('orders by group then creation time and resolves state', () => {
    const parsed = parseSnapshot(
      snapshot(
        [
          session({ id: 'a', createdAt: '2026-11-06T12:00:00Z', groupId: 'g2' }),
          session({ id: 'b', createdAt: '2026-11-06T11:00:00Z', groupId: 'g1', running: false }),
          session({
            id: 'c',
            createdAt: '2026-11-06T09:00:00Z',
            groupId: 'g1',
            status: { state: 'blocked' },
            currentAttention: { priority: 2, reason: 'permission' },
          }),
        ],
        [
          { id: 'g1', parentId: null, name: 'First', order: 0 },
          { id: 'g2', parentId: null, name: 'Second', order: 1 },
        ],
      ),
    );
    assert.ok(parsed);
    const rows = buildSessionRows(parsed);
    assert.deepEqual(
      rows.map(row => [row.id, row.state, row.needsAttention, row.groupName]),
      [
        ['c', 'blocked', true, 'First'],
        ['b', 'exited', false, 'First'],
        ['a', 'unknown', false, 'Second'],
      ],
    );
  });
});
