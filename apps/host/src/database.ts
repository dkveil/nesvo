import { installInboxTables } from './inbox-rules/store';
import { hostDiagnostic } from './log-redaction';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { migrateCosts } from './cost-store';
import { migrateTranscriptCosts } from './cost-transcripts';
import { installHistoryIndex } from './sessions/history-index';
import { installTranscriptIndex } from './sessions/transcript-index';
import { installCodeReviewTables } from './code-review/store';
import { installTrackedRepositoryTables } from './tracked-repositories';
import { installWorktreeRecipeTables } from './worktree-recipes/store';
import { installSessionControlTables } from './session-control/store';
import { installGateRuleTables } from './workflows/gate-rule-store';
import { installLessonTables } from './lessons/store';

const DATABASE_VERSION = 30;
class NewerDatabaseError extends Error {}
class DatabaseIntegrityError extends Error {}
const BACKUP_LIMIT = 3;

const migrationBackups = (path: string): string[] =>
  readdirSync(dirname(path), { withFileTypes: true })
    .filter(
      entry => entry.isFile() && /^nesvo\.sqlite\.v\d+\.bak$/.test(entry.name),
    )
    .map(entry => {
      const file = join(dirname(path), entry.name);
      return { file, modified: statSync(file).mtimeMs };
    })
    .sort((first, second) => second.modified - first.modified)
    .map(entry => entry.file);

const vacuumInto = (database: DatabaseSync, backup: string) => {
  const temporary = `${backup}.${randomUUID()}.tmp`;
  try {
    database.prepare('VACUUM INTO ?').run(temporary);
    renameSync(temporary, backup);
  } finally {
    rmSync(temporary, { force: true });
  }
};

const backupTimestamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(':', '-');

export const backupDatabaseNow = (
  database: DatabaseSync,
  directory: string,
  now = new Date(),
) => {
  const backup = join(
    directory,
    `nesvo.sqlite.backup-${backupTimestamp(now)}.bak`,
  );
  if (statSync(backup, { throwIfNoEntry: false }))
    throw new Error('A backup was written a moment ago. Try again shortly.');
  vacuumInto(database, backup);
  return {
    path: backup,
    bytes: statSync(backup).size,
    createdAt: now.toISOString(),
  };
};

const backupBeforeMigration = (
  database: DatabaseSync,
  path: string,
  version: number,
) => {
  const backup = `${path}.v${version}.bak`;
  vacuumInto(database, backup);
  for (const file of migrationBackups(path)
    .filter(file => file !== backup)
    .slice(BACKUP_LIMIT - 1))
    rmSync(file);
};

const checkDatabase = (database: DatabaseSync, path: string) => {
  try {
    const problems = database
      .prepare('PRAGMA quick_check')
      .all()
      .map(row => row.quick_check)
      .filter(
        problem =>
          problem !== 'ok' && problem !== 'CHECK constraint failed in sessions',
      );
    if (problems.length) throw new Error(String(problems[0]));
  } catch (error) {
    throw new DatabaseIntegrityError(
      `SQLite integrity check failed for ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const lockDataDirectory = (directory: string) => {
  mkdirSync(directory, { recursive: true });
  const ownership = new DatabaseSync(join(directory, 'ownership.sqlite'));
  try {
    ownership.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    return ownership;
  } catch (error) {
    ownership.close();
    if ((error as { errcode?: number }).errcode === 5) {
      hostDiagnostic('Another Nesvo host already owns this data directory.');
      throw new Error('Another Nesvo host already owns this data directory.');
    }
    throw error;
  }
};

export const ownDataDirectory = (directory: string) =>
  Effect.acquireRelease(
    Effect.try(() => lockDataDirectory(directory)),
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
  const rows = database
    .prepare(`SELECT id, document FROM ${table} WHERE json_valid(document)`)
    .all();
  const update = database.prepare(
    `UPDATE ${table} SET document = ? WHERE id = ?`,
  );
  for (const row of rows) {
    const document = JSON.parse(String(row.document)) as Record<
      string,
      unknown
    > | null;
    if (!document || typeof document !== 'object' || Array.isArray(document))
      continue;
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
      for (const message of document.messages as (Record<
        string,
        unknown
      > | null)[])
        if (message?.origin === 'pipeline') message.origin = 'workflow';
  });
  rewriteDocuments(database, 'workflow_runs', document =>
    renameKeys(document, { pipeline: 'workflow' }),
  );
};

export const openDatabaseSync = (directory: string): DatabaseSync => {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'nesvo.sqlite');
  const existing = Boolean(statSync(path, { throwIfNoEntry: false })?.size);
  const database = new DatabaseSync(path);
  try {
    checkDatabase(database, path);
    const version = database.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number')
      throw new Error(`Could not read the database version for ${path}.`);
    if (version > DATABASE_VERSION) {
      const backups = migrationBackups(path);
      throw new NewerDatabaseError(
        `Database ${path} uses schema version ${version}. A newer Nesvo is needed.${backups.length ? ` Backups: ${backups.map(file => basename(file)).join(', ')}.` : ''}`,
      );
    }
    if (existing && version < DATABASE_VERSION)
      backupBeforeMigration(database, path, version);
    database.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA secure_delete = ON;',
    );
    database.exec('BEGIN IMMEDIATE');
    try {
      if (version < 15)
        database.exec('DROP TRIGGER IF EXISTS history_session_update');
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
      database.exec(
        'CREATE TABLE IF NOT EXISTS session_quarantine (session_id TEXT PRIMARY KEY REFERENCES sessions(id), document TEXT NOT NULL, error_summary TEXT NOT NULL, quarantined_at TEXT NOT NULL)',
      );
      if (version < 3)
        database.exec(
          "UPDATE sessions SET document = json_set(document, '$.mode', 'read-only', '$.pendingApprovals', json('[]')) WHERE json_valid(document)",
        );
      if (version < 4)
        database.exec(
          "UPDATE sessions SET document = json_set(document, '$.parentId', NULL, '$.parentRunId', NULL, '$.scope', NULL, '$.delegationEnabled', json('false'), '$.delegations', json('[]')) WHERE json_valid(document)",
        );
      database.exec(
        'CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, document TEXT NOT NULL CHECK (json_valid(document)), updated_at TEXT NOT NULL, UNIQUE(session_id, version))',
      );
      if (version < 6)
        database.exec(
          "UPDATE sessions SET document = json_set(document, '$.activities', json('[]'), '$.activitiesTruncated', json('false'), '$.activityTruncatedRunIds', json('[]')) WHERE json_valid(document)",
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
      database.exec(
        "CREATE TABLE IF NOT EXISTS provider_profiles (id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK (provider IN ('Claude Code', 'Codex')), label TEXT NOT NULL, config_directory TEXT NOT NULL, directory_key TEXT NOT NULL, UNIQUE (provider, directory_key))",
      );
      if (!sessionColumns.has('profile_id'))
        database.exec(
          'ALTER TABLE sessions ADD COLUMN profile_id TEXT REFERENCES provider_profiles(id)',
        );
      database.exec(
        "CREATE INDEX IF NOT EXISTS sessions_profile ON sessions (profile_id); CREATE TRIGGER IF NOT EXISTS session_profile_immutable BEFORE UPDATE OF profile_id ON sessions WHEN OLD.profile_id IS NOT NEW.profile_id BEGIN SELECT RAISE(ABORT, 'A session account cannot be changed.'); END",
      );
      if (!sessionColumns.has('create_request_id'))
        database.exec('ALTER TABLE sessions ADD COLUMN create_request_id TEXT');
      database.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS sessions_create_request ON sessions (create_request_id) WHERE create_request_id IS NOT NULL',
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
      for (const column of [
        'change_trigger',
        'last_check',
        'pending_start',
        'ritual_options',
      ])
        if (!scheduledJobColumns.has(column))
          database.exec(
            `ALTER TABLE scheduled_jobs ADD COLUMN ${column} TEXT CHECK (${column} IS NULL OR json_valid(${column}))`,
          );
      if (!scheduledJobColumns.has('pull_request_review'))
        database.exec(
          'ALTER TABLE scheduled_jobs ADD COLUMN pull_request_review TEXT CHECK (pull_request_review IS NULL OR json_valid(pull_request_review))',
        );
      if (!scheduledJobColumns.has('check_hash'))
        database.exec('ALTER TABLE scheduled_jobs ADD COLUMN check_hash TEXT');
      database.exec(
        'CREATE TABLE IF NOT EXISTS scheduled_job_run_days (scheduled_job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE, day TEXT NOT NULL, starts INTEGER NOT NULL, PRIMARY KEY (scheduled_job_id, day))',
      );
      const scheduledJobRunColumns = new Set(
        database
          .prepare('PRAGMA table_info(scheduled_job_runs)')
          .all()
          .map(column => column.name),
      );
      if (!scheduledJobRunColumns.has('ritual_result'))
        database.exec(
          'ALTER TABLE scheduled_job_runs ADD COLUMN ritual_result TEXT CHECK (ritual_result IS NULL OR json_valid(ritual_result))',
        );
      database.exec(
        'CREATE TABLE IF NOT EXISTS scheduled_job_ci_heads (scheduled_job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE, head_key TEXT NOT NULL, PRIMARY KEY (scheduled_job_id, head_key))',
      );
      if (!scheduledJobRunColumns.has('workflow_run_id'))
        database.exec(
          'ALTER TABLE scheduled_job_runs ADD COLUMN workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL',
        );
      if (version < 10 && version >= 8) renameWorkflowDocumentKeys(database);
      database.exec(
        "CREATE TABLE IF NOT EXISTS assistant_changes (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence > 0), status TEXT NOT NULL CHECK (status IN ('applied', 'undone')), document TEXT NOT NULL CHECK (json_valid(document)), previous TEXT, definitions_root TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (conversation_id, sequence))",
      );
      if (!columnNames(database, 'assistant_changes').has('definitions_root'))
        database.exec(
          'ALTER TABLE assistant_changes ADD COLUMN definitions_root TEXT',
        );
      database.exec(
        'CREATE TABLE IF NOT EXISTS session_groups (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES session_groups(id), name TEXT NOT NULL, sort_order INTEGER NOT NULL, defaults TEXT NOT NULL CHECK (json_valid(defaults)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
      );
      database.exec(
        'CREATE INDEX IF NOT EXISTS session_groups_parent ON session_groups (parent_id, sort_order)',
      );
      database.exec(
        'CREATE TABLE IF NOT EXISTS session_tombstones (session_id TEXT PRIMARY KEY REFERENCES sessions(id), root_id TEXT NOT NULL, deleted_at TEXT NOT NULL, purge_after TEXT NOT NULL, purged_at TEXT)',
      );
      database.exec(
        'CREATE INDEX IF NOT EXISTS session_tombstones_root ON session_tombstones (root_id); CREATE INDEX IF NOT EXISTS session_tombstones_pending ON session_tombstones (purge_after) WHERE purged_at IS NULL',
      );
      installCodeReviewTables(database);
      installTrackedRepositoryTables(database);
      installWorktreeRecipeTables(database);
      installSessionControlTables(database);
      installLessonTables(database);
      installGateRuleTables(database);
      installHistoryIndex(database, version < 12, version < 15);
      if (version < 14) migrateCosts(database);
      if (version < 28) migrateTranscriptCosts(database);
      installTranscriptIndex(database);
      installInboxTables(database);
      database.exec(
        'CREATE TABLE IF NOT EXISTS mcp_repository_trust (provider TEXT NOT NULL, repository TEXT NOT NULL, fingerprint TEXT NOT NULL, definitions TEXT NOT NULL CHECK (json_valid(definitions)), trusted INTEGER NOT NULL CHECK (trusted IN (0, 1)), PRIMARY KEY (provider, repository))',
      );
      database.exec(`PRAGMA user_version = ${DATABASE_VERSION}; COMMIT`);
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
    Effect.try(() => {
      try {
        return openDatabaseSync(directory);
      } catch (error) {
        hostDiagnostic(
          error instanceof NewerDatabaseError
            ? 'A newer Nesvo is needed.'
            : error instanceof DatabaseIntegrityError
              ? 'SQLite integrity check failed.'
              : 'The database could not be opened.',
        );
        throw error;
      }
    }),
    database => Effect.sync(() => database.close()),
  );
