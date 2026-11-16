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

const tableNames = (database: DatabaseSync) =>
  new Set(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(row => String(row.name)),
  );

const columnNames = (database: DatabaseSync, table: string) =>
  new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map(row => String(row.name)),
  );

const renameColumn = (
  database: DatabaseSync,
  table: string,
  legacy: string,
  current: string,
) => {
  if (!tableNames(database).has(table)) return;
  const columns = columnNames(database, table);
  if (columns.has(legacy) && !columns.has(current))
    database.exec(`ALTER TABLE ${table} RENAME COLUMN ${legacy} TO ${current}`);
};

const renameWorkflowTables = (database: DatabaseSync) => {
  const tables = tableNames(database);
  if (tables.has('pipeline_runs') && !tables.has('workflow_runs'))
    database.exec(
      'ALTER TABLE pipeline_runs RENAME TO workflow_runs; DROP INDEX IF EXISTS pipeline_runs_project; DROP INDEX IF EXISTS pipeline_runs_status; DROP INDEX IF EXISTS pipeline_runs_recent',
    );
  if (tables.has('pipeline_steps') && !tables.has('workflow_steps'))
    database.exec('ALTER TABLE pipeline_steps RENAME TO workflow_steps');
  renameColumn(database, 'workflow_runs', 'pipeline_name', 'workflow_name');
  renameColumn(database, 'sessions', 'pipeline_run_id', 'workflow_run_id');
  renameColumn(database, 'sessions', 'pipeline_step_id', 'workflow_step_id');
  database.exec(
    'DROP INDEX IF EXISTS sessions_pipeline_run; DROP INDEX IF EXISTS sessions_pipeline_step',
  );
  renameColumn(database, 'scheduled_jobs', 'pipeline', 'workflow');
  renameColumn(
    database,
    'scheduled_job_runs',
    'pipeline_run_id',
    'workflow_run_id',
  );
};

const renameKeys = (
  value: Record<string, unknown>,
  keys: Record<string, string>,
) => {
  for (const [legacy, current] of Object.entries(keys)) {
    if (!(legacy in value)) continue;
    if (!(current in value)) value[current] = value[legacy];
    delete value[legacy];
  }
  return value;
};

const rewriteDocuments = (
  database: DatabaseSync,
  table: string,
  rewrite: (document: Record<string, unknown>) => void,
) => {
  const rows = database.prepare(`SELECT id, document FROM ${table}`).all();
  const update = database.prepare(
    `UPDATE ${table} SET document = ? WHERE id = ?`,
  );
  for (const row of rows) {
    const document = JSON.parse(String(row.document)) as Record<
      string,
      unknown
    >;
    rewrite(document);
    update.run(JSON.stringify(document), String(row.id));
  }
};

const renameWorkflowDocumentKeys = (database: DatabaseSync) => {
  rewriteDocuments(database, 'sessions', document => {
    renameKeys(document, {
      pipelineRunId: 'workflowRunId',
      pipelineStepId: 'workflowStepId',
    });
    if (Array.isArray(document.messages))
      for (const message of document.messages as Record<string, unknown>[])
        if (message.origin === 'pipeline') message.origin = 'workflow';
  });
  rewriteDocuments(database, 'workflow_runs', document =>
    renameKeys(document, { pipeline: 'workflow' }),
  );
};

export const openDatabaseSync = (directory: string): DatabaseSync => {
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(join(directory, 'nesvo.sqlite'));
  try {
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || version > 11) {
      throw new Error('Unsupported database version');
    }
    database.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250;',
    );
    database.exec('BEGIN IMMEDIATE');
    try {
      if (version < 10) renameWorkflowTables(database);
      database.exec(
        'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      );
      database
        .prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)')
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
        'CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0), directory TEXT NOT NULL, project_root TEXT NOT NULL, workflow_name TEXT NOT NULL, spec_path TEXT NOT NULL, spec_hash TEXT NOT NULL, document TEXT NOT NULL CHECK (json_valid(document)), status TEXT NOT NULL, phase TEXT, current_step_index INTEGER, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT)',
      );
      database.exec(
        'CREATE INDEX IF NOT EXISTS workflow_runs_project ON workflow_runs (project_root, created_at DESC); CREATE INDEX IF NOT EXISTS workflow_runs_status ON workflow_runs (status); CREATE INDEX IF NOT EXISTS workflow_runs_recent ON workflow_runs (updated_at DESC, id DESC)',
      );
      database.exec(
        'CREATE TABLE IF NOT EXISTS workflow_steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK (revision > 0), step_index INTEGER NOT NULL CHECK (step_index >= 0), name TEXT NOT NULL, type TEXT NOT NULL, phase TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL CHECK (attempt >= 0), document TEXT NOT NULL CHECK (json_valid(document)), session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, review_id TEXT REFERENCES reviews(id) ON DELETE SET NULL, review_version INTEGER, started_at TEXT, updated_at TEXT NOT NULL, UNIQUE (run_id, step_index, attempt))',
      );
      if (!sessionColumns.has('workflow_run_id'))
        database.exec(
          'ALTER TABLE sessions ADD COLUMN workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL',
        );
      if (!sessionColumns.has('workflow_step_id'))
        database.exec(
          'ALTER TABLE sessions ADD COLUMN workflow_step_id TEXT REFERENCES workflow_steps(id) ON DELETE SET NULL',
        );
      database.exec(
        'CREATE INDEX IF NOT EXISTS sessions_workflow_run ON sessions (workflow_run_id); CREATE INDEX IF NOT EXISTS sessions_workflow_step ON sessions (workflow_step_id)',
      );
      const scheduledJobColumns = new Set(
        database
          .prepare('PRAGMA table_info(scheduled_jobs)')
          .all()
          .map(column => column.name),
      );
      if (!scheduledJobColumns.has('workflow'))
        database.exec(
          'ALTER TABLE scheduled_jobs ADD COLUMN workflow TEXT CHECK (workflow IS NULL OR json_valid(workflow))',
        );
      const scheduledJobRunColumns = new Set(
        database
          .prepare('PRAGMA table_info(scheduled_job_runs)')
          .all()
          .map(column => column.name),
      );
      if (!scheduledJobRunColumns.has('workflow_run_id'))
        database.exec(
          'ALTER TABLE scheduled_job_runs ADD COLUMN workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL',
        );
      if (version < 10 && version >= 8) renameWorkflowDocumentKeys(database);
      database.exec(
        "CREATE TABLE IF NOT EXISTS assistant_changes (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0), status TEXT NOT NULL CHECK (status IN ('applied', 'undone')), document TEXT NOT NULL CHECK (json_valid(document)), previous TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (conversation_id, sequence))",
      );
      database.exec('PRAGMA user_version = 11; COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export const openDatabase = (directory: string) =>
  Effect.acquireRelease(
    Effect.try(() => openDatabaseSync(directory)),
    database => Effect.sync(() => database.close()),
  );
