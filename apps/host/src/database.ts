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
        if (typeof version !== 'number' || version > 3) {
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
          database.exec('PRAGMA user_version = 3; COMMIT');
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
