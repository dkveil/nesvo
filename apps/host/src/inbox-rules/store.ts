import { inboxItemSchema, type InboxItem } from '@nesvo/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

const KEPT_DECIDED_ITEMS = 300;

export const inboxBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('provider'),
    runId: z.uuid(),
    approvalId: z.string().min(1).max(200),
    fingerprint: z.string().max(64).nullable(),
  }),
  z.strictObject({
    kind: z.literal('pull-request'),
    input: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal('workflow-step'),
    runId: z.uuid(),
    stepName: z.string().max(200),
    attempt: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('session'),
    runId: z.uuid().nullable(),
  }),
]);
export type InboxBinding = z.infer<typeof inboxBindingSchema>;

export type StoredInboxItem = { item: InboxItem; binding: InboxBinding };

export const installInboxTables = (database: DatabaseSync) => {
  database.exec(
    "CREATE TABLE IF NOT EXISTS inbox_items (id TEXT PRIMARY KEY, session_id TEXT, status TEXT NOT NULL, dedupe TEXT UNIQUE, document TEXT NOT NULL CHECK (json_valid(document)), binding TEXT NOT NULL CHECK (json_valid(binding)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS inbox_items_status ON inbox_items (status, created_at)',
  );
  database.exec(
    "CREATE TABLE IF NOT EXISTS inbox_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
};

const parse = (row: Record<string, unknown>): StoredInboxItem | null => {
  try {
    return {
      item: inboxItemSchema.parse(JSON.parse(String(row.document))),
      binding: inboxBindingSchema.parse(JSON.parse(String(row.binding))),
    };
  } catch {
    return null;
  }
};

export class InboxItemStore {
  constructor(private readonly database: DatabaseSync) {}

  insert(stored: StoredInboxItem, dedupe: string | null): boolean {
    const result = this.database
      .prepare(
        'INSERT OR IGNORE INTO inbox_items (id, session_id, status, dedupe, document, binding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        stored.item.id,
        stored.item.sessionId,
        stored.item.status,
        dedupe,
        JSON.stringify(stored.item),
        JSON.stringify(stored.binding),
        stored.item.createdAt,
        stored.item.createdAt,
      );
    this.prune();
    return Number(result.changes) > 0;
  }

  update(item: InboxItem, expectedStatus: InboxItem['status']): boolean {
    const result = this.database
      .prepare(
        'UPDATE inbox_items SET status = ?, document = ?, updated_at = ? WHERE id = ? AND status = ?',
      )
      .run(
        item.status,
        JSON.stringify(item),
        item.decidedAt ?? new Date().toISOString(),
        item.id,
        expectedStatus,
      );
    return Number(result.changes) > 0;
  }

  get(id: string): StoredInboxItem | null {
    const row = this.database
      .prepare('SELECT document, binding FROM inbox_items WHERE id = ?')
      .get(id);
    return row ? parse(row) : null;
  }

  list(): StoredInboxItem[] {
    return this.database
      .prepare(
        "SELECT document, binding FROM inbox_items ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 500",
      )
      .all()
      .map(parse)
      .filter((value): value is StoredInboxItem => value !== null);
  }

  pending(): StoredInboxItem[] {
    return this.database
      .prepare(
        "SELECT document, binding FROM inbox_items WHERE status = 'pending' ORDER BY created_at",
      )
      .all()
      .map(parse)
      .filter((value): value is StoredInboxItem => value !== null);
  }

  setting(key: string): string | null {
    const row = this.database
      .prepare('SELECT value FROM inbox_settings WHERE key = ?')
      .get(key);
    return row ? String(row.value) : null;
  }

  saveSetting(key: string, value: string): void {
    this.database
      .prepare(
        'INSERT INTO inbox_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  private prune(): void {
    this.database
      .prepare(
        "DELETE FROM inbox_items WHERE status != 'pending' AND id NOT IN (SELECT id FROM inbox_items WHERE status != 'pending' ORDER BY updated_at DESC LIMIT ?)",
      )
      .run(KEPT_DECIDED_ITEMS);
  }
}
