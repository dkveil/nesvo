import type { DatabaseSync } from 'node:sqlite';
import {
  assistantChangeLimits,
  assistantChangeSchema,
  type AssistantChange,
  type ConfigurationChange,
  type ConfigurationHistoryInput,
  type ConfigurationMutation,
  type ConfigurationReceipt,
  type ConfigurationValue,
  type ConfigurationVersion,
  configurationLimits,
} from '@nesvo/contracts';

export type ConfigurationSnapshot = {
  version: ConfigurationVersion;
  value: ConfigurationValue | null;
  identity: string;
  dependencies: string;
};

export type StoredConfigurationChange = {
  change: ConfigurationChange;
  mutation: ConfigurationMutation;
  before: ConfigurationSnapshot;
  after: ConfigurationSnapshot;
  verb?: 'propose' | 'apply';
};

export type ConfigurationAction = {
  principal: string;
  id: string;
  fingerprint: string;
};

export type ConfigurationIntent = {
  action: ConfigurationAction;
  record: StoredConfigurationChange;
  from: ConfigurationSnapshot;
  to: ConfigurationSnapshot;
};

export function installConfigurationTables(database: DatabaseSync): void {
  if (
    !database
      .prepare('PRAGMA table_info(metadata)')
      .all()
      .some(column => column.name === 'revision')
  )
    database.exec(
      'ALTER TABLE metadata ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
    );
  database.exec(`
    CREATE TABLE IF NOT EXISTS configuration_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      area TEXT NOT NULL,
      status TEXT NOT NULL,
      device_id TEXT,
      document TEXT NOT NULL CHECK (json_valid(document))
    );
    CREATE INDEX IF NOT EXISTS configuration_changes_pending
      ON configuration_changes (status, device_id);
    CREATE TABLE IF NOT EXISTS configuration_receipts (
      principal TEXT NOT NULL,
      id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      change_id TEXT NOT NULL,
      result TEXT NOT NULL CHECK (json_valid(result)),
      PRIMARY KEY (principal, id)
    );
    CREATE TABLE IF NOT EXISTS configuration_intents (
      change_id TEXT PRIMARY KEY,
      document TEXT NOT NULL CHECK (json_valid(document))
    );
    CREATE TABLE IF NOT EXISTS configuration_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      grants TEXT NOT NULL CHECK (json_valid(grants))
    );
    CREATE TABLE IF NOT EXISTS configuration_inbox_conversations (
      subject TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}

export function metadataRevision(database: DatabaseSync, key: string): number {
  return Number(
    database.prepare('SELECT revision FROM metadata WHERE key = ?').get(key)
      ?.revision ?? 0,
  );
}

export function saveVersionedMetadata(
  database: DatabaseSync,
  key: string,
  value: string,
): void {
  database
    .prepare(
      `
    INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = metadata.revision + 1
  `,
    )
    .run(key, value);
}

export class ConfigurationChangeStore {
  constructor(private readonly database: DatabaseSync) {}

  transaction<T>(run: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(id: string): StoredConfigurationChange | null {
    const row = this.database
      .prepare('SELECT document FROM configuration_changes WHERE id = ?')
      .get(id);
    return row
      ? (JSON.parse(String(row.document)) as StoredConfigurationChange)
      : null;
  }

  list(input: ConfigurationHistoryInput) {
    const rows = this.database
      .prepare(
        `
      SELECT sequence, document FROM configuration_changes
      WHERE sequence < COALESCE(?, 9223372036854775807)
        AND (? IS NULL OR area = ?) AND (? IS NULL OR status = ?)
      ORDER BY sequence DESC LIMIT ?
    `,
      )
      .all(
        input.after ?? null,
        input.area ?? null,
        input.area ?? null,
        input.status ?? null,
        input.status ?? null,
        configurationLimits.page + 1,
      );
    const page = rows.slice(0, configurationLimits.page);
    return {
      changes: page.map(
        row =>
          (JSON.parse(String(row.document)) as StoredConfigurationChange)
            .change,
      ),
      next: rows.length > page.length ? Number(page.at(-1)?.sequence) : null,
    };
  }

  save(record: StoredConfigurationChange): void {
    const { change } = record;
    this.database
      .prepare(
        `
      INSERT INTO configuration_changes (id, area, status, device_id, document)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, document = excluded.document
    `,
      )
      .run(
        change.id,
        change.target.area,
        change.status,
        change.source.kind === 'device' ? change.source.deviceId : null,
        JSON.stringify(record),
      );
  }

  pending(deviceId: string | null) {
    const row = this.database
      .prepare(
        `
      SELECT COUNT(*) AS total, COUNT(CASE WHEN device_id = ? THEN 1 END) AS device
      FROM configuration_changes WHERE status = 'pending'
    `,
      )
      .get(deviceId);
    return { total: Number(row?.total), device: Number(row?.device) };
  }

  receipt(principal: string, id: string) {
    const row = this.database
      .prepare(
        `
      SELECT fingerprint, result FROM configuration_receipts
      WHERE principal = ? AND id = ?
    `,
      )
      .get(principal, id);
    return row
      ? {
          fingerprint: String(row.fingerprint),
          receipt: JSON.parse(String(row.result)) as ConfigurationReceipt,
        }
      : null;
  }

  settle(
    action: ConfigurationAction,
    record: StoredConfigurationChange,
  ): ConfigurationReceipt {
    this.save(record);
    const { id, status, revision, resultingVersion } = record.change;
    const receipt = { id, status, revision, resultingVersion };
    this.database
      .prepare(
        `
      INSERT INTO configuration_receipts (principal, id, fingerprint, change_id, result)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(
        action.principal,
        action.id,
        action.fingerprint,
        id,
        JSON.stringify(receipt),
      );
    return receipt;
  }

  intent(intent: ConfigurationIntent): void {
    this.database
      .prepare(
        `
      INSERT INTO configuration_intents (change_id, document) VALUES (?, ?)
    `,
      )
      .run(intent.record.change.id, JSON.stringify(intent));
  }

  intents(): ConfigurationIntent[] {
    return this.database
      .prepare('SELECT document FROM configuration_intents')
      .all()
      .map(row => JSON.parse(String(row.document)) as ConfigurationIntent);
  }

  hasIntent(id: string): boolean {
    return !!this.database
      .prepare('SELECT 1 FROM configuration_intents WHERE change_id = ?')
      .get(id);
  }

  completeIntent(intent: ConfigurationIntent): ConfigurationReceipt {
    return this.transaction(() => {
      const receipt = this.settle(intent.action, intent.record);
      this.database
        .prepare('DELETE FROM configuration_intents WHERE change_id = ?')
        .run(intent.record.change.id);
      return receipt;
    });
  }
}

export type StoredAssistantChange = {
  change: AssistantChange;
  previous: string | null;
  root: string | null;
};

export class AssistantChangeStore {
  constructor(private readonly database: DatabaseSync) {}

  nextSequence(conversationId: string): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(sequence), 0) AS last FROM assistant_changes WHERE conversation_id = ?',
      )
      .get(conversationId);
    return Number(row?.last ?? 0) + 1;
  }

  insert(
    change: AssistantChange,
    previous: string | null,
    root: string | null,
  ): void {
    this.database
      .prepare(
        'INSERT INTO assistant_changes (id, conversation_id, sequence, status, document, previous, definitions_root, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        change.changeId,
        change.conversationId,
        change.sequence,
        change.status,
        JSON.stringify(change),
        previous,
        root,
        change.at,
        change.at,
      );
  }

  markUndone(change: AssistantChange): boolean {
    return (
      this.database
        .prepare(
          "UPDATE assistant_changes SET status = 'undone', document = ?, updated_at = ? WHERE id = ? AND status = 'applied'",
        )
        .run(JSON.stringify(change), change.undoneAt, change.changeId)
        .changes === 1
    );
  }

  get(conversationId: string, changeId: string): StoredAssistantChange | null {
    const row = this.database
      .prepare(
        'SELECT document, previous, definitions_root FROM assistant_changes WHERE id = ? AND conversation_id = ?',
      )
      .get(changeId, conversationId);
    if (!row) return null;
    return {
      change: assistantChangeSchema.parse(JSON.parse(String(row.document))),
      previous: row.previous === null ? null : String(row.previous),
      root: row.definitions_root === null ? null : String(row.definitions_root),
    };
  }

  list(conversationId: string): AssistantChange[] {
    return this.database
      .prepare(
        'SELECT document FROM (SELECT document, sequence FROM assistant_changes WHERE conversation_id = ? ORDER BY sequence DESC LIMIT ?) ORDER BY sequence',
      )
      .all(conversationId, assistantChangeLimits.history)
      .map(row =>
        assistantChangeSchema.parse(JSON.parse(String(row.document))),
      );
  }
}
