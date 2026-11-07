import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';

export const openDatabase = (directory: string) =>
  Effect.acquireRelease(
    Effect.try(() => {
      mkdirSync(directory, { recursive: true });
      const database = new DatabaseSync(join(directory, 'nesvo.sqlite'));
      try {
        const version = database
          .prepare('PRAGMA user_version')
          .get()?.user_version;
        if (typeof version !== 'number' || version > 6) {
          throw new Error('Unsupported database version');
        }
        database.exec(
          'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250;',
        );
        database.exec('BEGIN IMMEDIATE');
        try {
          database.exec(
            'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
          );
          database
            .prepare(
              'INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)',
            )
            .run('instance_id', randomUUID());
          database.exec(
            'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK (json_valid(document)), updated_at TEXT NOT NULL)',
          );
          if (version < 3)
            database.exec(
              "UPDATE sessions SET document = json_set(document, '$.mode', 'read-only', '$.pendingApprovals', json('[]'))",
            );
          if (version < 4)
            database.exec(
              "UPDATE sessions SET document = json_set(document, '$.parentId', NULL, '$.parentRunId', NULL, '$.scope', NULL, '$.delegationEnabled', json('false'), '$.delegations', json('[]'))",
            );
          database.exec(
            'CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, document TEXT NOT NULL CHECK (json_valid(document)), updated_at TEXT NOT NULL, UNIQUE(session_id, version))',
          );
          if (version < 6)
            database.exec(
              "UPDATE sessions SET document = json_set(document, '$.activities', json('[]'), '$.activitiesTruncated', json('false'), '$.activityTruncatedRunIds', json('[]'))",
            );
          database.exec('PRAGMA user_version = 6; COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        return database;
      } catch (error) {
        database.close();
        throw error;
      }
    }),
    database => Effect.sync(() => database.close()),
  );
