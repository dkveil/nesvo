import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';

export const ownDataDirectory = (directory: string) =>
  Effect.acquireRelease(
    Effect.try(() => {
      mkdirSync(directory, { recursive: true });
      const ownership = new DatabaseSync(join(directory, 'ownership.sqlite'));
      try {
        ownership.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
        return ownership;
      } catch (error) {
        ownership.close();
        if ((error as { errcode?: number }).errcode === 5) {
          console.error('Another Nesvo host already owns this data directory.');
          throw new Error(
            'Another Nesvo host already owns this data directory.',
          );
        }
        throw error;
      }
    }),
    ownership => Effect.sync(() => ownership.close()),
  );

export const openDatabase = (directory: string) =>
  Effect.acquireRelease(
    Effect.try(() => {
      mkdirSync(directory, { recursive: true });
      const database = new DatabaseSync(join(directory, 'nesvo.sqlite'));
      try {
        const version = database
          .prepare('PRAGMA user_version')
          .get()?.user_version;
        if (typeof version !== 'number' || version > 8) {
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
          database.exec(
            "CREATE TABLE IF NOT EXISTS scheduled_jobs (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), name TEXT NOT NULL, prompt TEXT NOT NULL, directory TEXT NOT NULL, provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')), model TEXT NOT NULL, effort TEXT, mode TEXT NOT NULL CHECK (mode = 'read-only'), schedule TEXT NOT NULL CHECK (json_valid(schedule)), time_zone TEXT NOT NULL, active INTEGER NOT NULL CHECK (active IN (0, 1)), timeout_minutes INTEGER NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK (active = 1 OR next_run_at IS NULL))",
          );
          database.exec(
            "CREATE TABLE IF NOT EXISTS scheduled_job_runs (id TEXT PRIMARY KEY, scheduled_job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE, scheduled_for TEXT, request_id TEXT UNIQUE, trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'manual')), status TEXT NOT NULL, reason TEXT, missed_count INTEGER NOT NULL CHECK (missed_count >= 0), session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, session_run_id TEXT, review_id TEXT REFERENCES reviews(id) ON DELETE SET NULL, reset_at TEXT, recorded_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, UNIQUE (scheduled_job_id, scheduled_for), CHECK ((trigger_kind = 'manual') = (scheduled_for IS NULL)), CHECK ((trigger_kind = 'manual') = (request_id IS NOT NULL)))",
          );
          database.exec(
            'CREATE INDEX IF NOT EXISTS scheduled_job_runs_recent ON scheduled_job_runs (scheduled_job_id, recorded_at DESC, id DESC)',
          );
          const sessionColumns = new Set(
            database
              .prepare('PRAGMA table_info(sessions)')
              .all()
              .map(column => column.name),
          );
          if (!sessionColumns.has('scheduled_job_id'))
            database.exec(
              'ALTER TABLE sessions ADD COLUMN scheduled_job_id TEXT REFERENCES scheduled_jobs(id) ON DELETE SET NULL',
            );
          if (!sessionColumns.has('scheduled_job_run_id'))
            database.exec(
              'ALTER TABLE sessions ADD COLUMN scheduled_job_run_id TEXT REFERENCES scheduled_job_runs(id) ON DELETE SET NULL',
            );
          database.exec(
            'CREATE INDEX IF NOT EXISTS sessions_scheduled_job ON sessions (scheduled_job_id); CREATE INDEX IF NOT EXISTS sessions_scheduled_job_run ON sessions (scheduled_job_run_id)',
          );
          database.exec(
            'CREATE TABLE IF NOT EXISTS pipeline_runs (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), directory TEXT NOT NULL, project_root TEXT NOT NULL, pipeline_name TEXT NOT NULL, spec_path TEXT NOT NULL, spec_hash TEXT NOT NULL, document TEXT NOT NULL CHECK (json_valid(document)), status TEXT NOT NULL, phase TEXT, current_step_index INTEGER, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT)',
          );
          database.exec(
            'CREATE INDEX IF NOT EXISTS pipeline_runs_project ON pipeline_runs (project_root, created_at DESC); CREATE INDEX IF NOT EXISTS pipeline_runs_status ON pipeline_runs (status); CREATE INDEX IF NOT EXISTS pipeline_runs_recent ON pipeline_runs (updated_at DESC, id DESC)',
          );
          database.exec(
            'CREATE TABLE IF NOT EXISTS pipeline_steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK (revision > 0), step_index INTEGER NOT NULL CHECK (step_index >= 0), name TEXT NOT NULL, type TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt >= 0), document TEXT NOT NULL CHECK (json_valid(document)), session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, review_id TEXT REFERENCES reviews(id) ON DELETE SET NULL, review_version INTEGER, started_at TEXT, updated_at TEXT NOT NULL, UNIQUE (run_id, step_index, attempt))',
          );
          if (!sessionColumns.has('pipeline_run_id'))
            database.exec(
              'ALTER TABLE sessions ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_runs(id) ON DELETE SET NULL',
            );
          if (!sessionColumns.has('pipeline_step_id'))
            database.exec(
              'ALTER TABLE sessions ADD COLUMN pipeline_step_id TEXT REFERENCES pipeline_steps(id) ON DELETE SET NULL',
            );
          database.exec(
            'CREATE INDEX IF NOT EXISTS sessions_pipeline_run ON sessions (pipeline_run_id); CREATE INDEX IF NOT EXISTS sessions_pipeline_step ON sessions (pipeline_step_id)',
          );
          database.exec('PRAGMA user_version = 8; COMMIT');
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
