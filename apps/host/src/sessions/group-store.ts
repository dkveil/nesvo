import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  compareGroupOrder,
  sessionGroupSchema,
  type SessionGroup,
  type SessionGroupList,
} from '@nesvo/contracts';

const REVISION_KEY = 'session_groups_revision';

const toGroup = (row: Record<string, SQLOutputValue>): SessionGroup =>
  sessionGroupSchema.parse({
    id: row.id,
    parentId: row.parentId ?? null,
    name: row.name,
    order: Number(row.sortOrder),
    defaults: JSON.parse(String(row.defaults)),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

export class SessionGroupStore {
  constructor(private readonly database: DatabaseSync) {}

  list(): SessionGroupList {
    const groups = this.database
      .prepare(
        'SELECT id, parent_id AS parentId, name, sort_order AS sortOrder, defaults, created_at AS createdAt, updated_at AS updatedAt FROM session_groups',
      )
      .all()
      .map(toGroup)
      .sort(compareGroupOrder);
    return { revision: this.revision(), groups };
  }

  get(id: string): SessionGroup | undefined {
    return this.list().groups.find(group => group.id === id);
  }

  write(groups: SessionGroup[], removed: string[] = []): void {
    const upsert = this.database.prepare(
      'INSERT INTO session_groups (id, parent_id, name, sort_order, defaults, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, sort_order = excluded.sort_order, defaults = excluded.defaults, updated_at = excluded.updated_at',
    );
    for (const group of groups) {
      const valid = sessionGroupSchema.parse(group);
      upsert.run(
        valid.id,
        valid.parentId,
        valid.name,
        valid.order,
        JSON.stringify(valid.defaults),
        valid.createdAt,
        valid.updatedAt,
      );
    }
    const remove = this.database.prepare(
      'DELETE FROM session_groups WHERE id = ?',
    );
    for (const id of removed) remove.run(id);
    this.database
      .prepare(
        'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(REVISION_KEY, String(this.revision() + 1));
  }

  private revision(): number {
    const row = this.database
      .prepare('SELECT value FROM metadata WHERE key = ?')
      .get(REVISION_KEY);
    return row ? Number(row.value) : 0;
  }
}
