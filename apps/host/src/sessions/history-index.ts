import type { DatabaseSync } from 'node:sqlite';

const TEXT_LIMIT = 8192;
const BACKFILL_MESSAGES = 64;

const titleEntry = (id: string, document: string, source = '') => `
  SELECT ${id}, '', 'title', substr(json_extract(${document}, '$.title'), 1, ${TEXT_LIMIT}),
    json_extract(${document}, '$.createdAt')
  ${source}
  WHERE json_type(${document}, '$.title') = 'text'
    AND json_type(${document}, '$.createdAt') = 'text'
`;

const messageEntries = (id: string, source: string) => `
  SELECT ${id}, value ->> '$.id', value ->> '$.author',
    substr(value ->> '$.body', 1, ${TEXT_LIMIT}), value ->> '$.createdAt'
  FROM ${source}
  WHERE value ->> '$.author' IN ('operator', 'agent') AND value ->> '$.body' <> ''
    AND json_type(value, '$.id') = 'text' AND json_type(value, '$.createdAt') = 'text'
`;

const indexSession = `
  INSERT INTO history_entries (session_id, message_id, role, body, created_at)
  ${titleEntry('NEW.id', 'NEW.document')}
  UNION ALL
  ${messageEntries('NEW.id', "json_each(NEW.document, '$.messages')")}
  ON CONFLICT(session_id, message_id) DO UPDATE SET
    role = excluded.role, body = excluded.body, created_at = excluded.created_at
  WHERE (role, body, created_at) IS NOT (excluded.role, excluded.body, excluded.created_at);
`;

export function supportsFts(database: DatabaseSync): boolean {
  try {
    database.exec(
      'CREATE VIRTUAL TABLE temp.history_fts_probe USING fts5(body)',
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('no such module: fts5')
    )
      return false;
    throw error;
  }
  database.exec('DROP TABLE temp.history_fts_probe');
  return true;
}

export function installHistoryIndex(
  database: DatabaseSync,
  upgrade: boolean,
  replaceSessionUpdate: boolean,
) {
  const mode = supportsFts(database) ? 'fts5' : 'like';
  const previous = database
    .prepare("SELECT value FROM metadata WHERE key = 'history_index_mode'")
    .get()?.value;
  const rebuild = mode !== previous || upgrade;
  if (!rebuild && !replaceSessionUpdate) return;

  if (rebuild)
    database.exec(`
    CREATE TABLE IF NOT EXISTS history_entries (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS history_entries_recent ON history_entries (created_at DESC, id DESC);
    DROP TRIGGER IF EXISTS history_fts_insert;
    DROP TRIGGER IF EXISTS history_fts_update;
    DROP TRIGGER IF EXISTS history_fts_delete;
    DELETE FROM history_entries;
    INSERT OR REPLACE INTO metadata (key, value) VALUES ('history_backfill', '');
    CREATE TRIGGER IF NOT EXISTS history_session_insert AFTER INSERT ON sessions BEGIN
      ${indexSession}
    END;
  `);
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS history_session_update AFTER UPDATE OF document ON sessions
    WHEN CASE WHEN NEW.document <> 'null' AND json_valid(OLD.document) THEN
      (OLD.document -> '$.title', OLD.document -> '$.messages') IS NOT
      (NEW.document -> '$.title', NEW.document -> '$.messages')
    ELSE 0 END
    BEGIN
      DELETE FROM history_entries WHERE session_id = NEW.id AND message_id <> ''
        AND message_id NOT IN (
          SELECT value ->> '$.id' FROM json_each(NEW.document, '$.messages')
          WHERE value ->> '$.body' <> ''
        );
      ${indexSession}
    END;
  `);

  if (!rebuild) return;

  if (mode === 'fts5') {
    database.exec(`
      DROP TABLE IF EXISTS history_fts;
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
        body, content = 'history_entries', content_rowid = 'id'
      );
      CREATE TRIGGER IF NOT EXISTS history_fts_insert AFTER INSERT ON history_entries BEGIN
        INSERT INTO history_fts (rowid, body) VALUES (NEW.id, NEW.body);
      END;
      CREATE TRIGGER IF NOT EXISTS history_fts_update AFTER UPDATE OF body ON history_entries
      WHEN OLD.body IS NOT NEW.body BEGIN
        INSERT INTO history_fts (history_fts, rowid, body) VALUES ('delete', OLD.id, OLD.body);
        INSERT INTO history_fts (rowid, body) VALUES (NEW.id, NEW.body);
      END;
      CREATE TRIGGER IF NOT EXISTS history_fts_delete AFTER DELETE ON history_entries BEGIN
        INSERT INTO history_fts (history_fts, rowid, body) VALUES ('delete', OLD.id, OLD.body);
      END;
    `);
  }
  database
    .prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('history_index_mode', ?)",
    )
    .run(mode);
}

export function backfillHistoryBatch(database: DatabaseSync): boolean {
  const cursor = database
    .prepare("SELECT value FROM metadata WHERE key = 'history_backfill'")
    .get()?.value;
  if (typeof cursor !== 'string') return false;
  const [afterId = '', position] = cursor.split(':');
  const offset = Number(position ?? 0);

  database.exec('BEGIN IMMEDIATE');
  try {
    const session = database
      .prepare(
        `
        SELECT id, json_array_length(document, '$.messages') AS messages
        FROM sessions WHERE id ${offset ? '>=' : '>'} ? ORDER BY id LIMIT 1
      `,
      )
      .get(afterId);
    if (!session) {
      database.exec(
        "DELETE FROM metadata WHERE key = 'history_backfill'; COMMIT",
      );
      return false;
    }
    const sessionId = String(session.id);
    const start = sessionId === afterId ? offset : 0;
    const end = start + BACKFILL_MESSAGES;
    if (!start)
      database
        .prepare(
          `
        INSERT OR IGNORE INTO history_entries (session_id, message_id, role, body, created_at)
          ${titleEntry('id', 'document', 'FROM (SELECT id, document FROM sessions WHERE id = ?)')}
      `,
        )
        .run(sessionId);

    database
      .prepare(
        `
      INSERT OR IGNORE INTO history_entries (session_id, message_id, role, body, created_at)
      ${messageEntries(
        'session_id',
        `(
        SELECT sessions.id AS session_id, value
        FROM sessions, json_each(document, '$.messages')
        WHERE sessions.id = ? LIMIT ${BACKFILL_MESSAGES} OFFSET ?
      )`,
      )}
    `,
      )
      .run(sessionId, start);
    database
      .prepare("UPDATE metadata SET value = ? WHERE key = 'history_backfill'")
      .run(end < Number(session.messages) ? `${sessionId}:${end}` : sessionId);
    database.exec('COMMIT');
    return true;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
