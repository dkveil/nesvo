import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { Provider } from '@nesvo/contracts';
import { z } from 'zod';
import {
  ImportSourceError,
  sourceFile,
  openImportSnapshot,
} from './import-snapshot';
import {
  explicitSourceRoot,
  sourceDate,
  sourceKey,
  sourceText,
  sourceTitle,
  type ManagerSource,
  type SourceGroup,
  type SourceSession,
} from './manager-source';

const threads = 'orchestration_v2_projection_threads';
const projects = 'projection_projects';
const providerThreads = 'orchestration_v2_projection_provider_threads';
const runs = 'orchestration_v2_projection_runs';

function catalog(database: DatabaseSync, root: string) {
  const tables = new Set(
    database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (?, ?, ?, ?)",
      )
      .all(threads, projects, providerThreads, runs)
      .map(row => row.name),
  );
  if (tables.size !== 4)
    throw new ImportSourceError(
      'unsupported',
      'This T3 Code store does not expose the supported v2 projections.',
    );

  const groupKey = (id: string) => sourceKey('t3-code', root, 'group', id);
  const threadKey = (id: string) => sourceKey('t3-code', root, 'session', id);
  database.function('nesvo_project_key', { deterministic: true }, id =>
    typeof id === 'string' ? groupKey(id) : null,
  );
  database.function('nesvo_thread_key', { deterministic: true }, id =>
    typeof id === 'string' ? threadKey(id) : null,
  );
  const projectsSql = `
    SELECT project_id, substr(title, 1, 80) AS title, substr(workspace_root, 1, 4097) AS workspace_root, archived_at
    FROM projection_projects WHERE deleted_at IS NULL`;
  const project = (
    row: Record<string, SQLOutputValue>,
  ): SourceGroup | undefined => {
    const id = sourceText(row.project_id, 512);
    if (!id) return;
    return {
      kind: 'group',
      key: groupKey(id),
      parent: null,
      title: sourceTitle(row.title, 'Untitled project', 80),
      directory: sourceText(row.workspace_root),
      archivedAt: sourceDate(row.archived_at),
      profile: null,
      order: 0,
    };
  };
  const sessionsSql = `
    SELECT t.thread_id, t.project_id, substr(t.title, 1, 100) AS title,
      t.archived_at, t.created_at, t.updated_at, substr(project.workspace_root, 1, 4097) AS workspace_root,
      substr(json_extract(t.payload_json, '$.worktreePath'), 1, 4097) AS worktree,
      substr(json_extract(t.payload_json, '$.branch'), 1, 513) AS branch,
      p.driver, p.status,
      json_extract(p.payload_json, '$.nativeThreadRef.driver') AS native_driver,
      json_extract(p.payload_json, '$.nativeThreadRef.strength') AS strength,
      substr(json_extract(p.payload_json, '$.nativeThreadRef.nativeId'), 1, 128) AS native_id,
      COALESCE(json_array_length(p.payload_json, '$.pendingBackgroundTasks'), 0) > 0 OR
      EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r
        WHERE r.thread_id = t.thread_id
          AND r.status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')) AS active
    FROM orchestration_v2_projection_threads t
    JOIN projection_projects project ON project.project_id = t.project_id AND project.deleted_at IS NULL
    LEFT JOIN orchestration_v2_projection_provider_threads p
      ON p.thread_id = t.thread_id AND p.provider_thread_id = t.active_provider_thread_id
    WHERE t.deleted_at IS NULL`;
  const session = (
    row: Record<string, SQLOutputValue>,
  ): SourceSession | undefined => {
    const id = sourceText(row.thread_id, 512);
    const projectId = sourceText(row.project_id, 512);
    if (!id || !projectId) return;
    const parent = groupKey(projectId);
    const provider: Provider | null =
      row.driver === 'claudeAgent'
        ? 'Claude Code'
        : row.driver === 'codex'
          ? 'Codex'
          : null;
    const nativeId = sourceText(row.native_id, 36);
    const hasWorktree = row.worktree !== null;
    let blocked: string | null = null;
    if (row.active === 1 || row.status === 'active')
      blocked = 'This thread has unsettled work in T3 Code.';
    else if (!row.driver) blocked = 'There is no active provider conversation.';
    else if (!provider) blocked = 'This provider cannot be imported.';
    else if (
      !['idle', 'archived', 'closed', 'error', 'not_loaded'].includes(
        String(row.status),
      )
    )
      blocked = 'The source does not confirm that this thread is settled.';
    else if (
      row.strength !== 'strong' ||
      row.native_driver !== row.driver ||
      !z.uuid().safeParse(nativeId).success
    )
      blocked = 'The native provider reference could not be verified.';
    return {
      kind: 'session',
      key: threadKey(id),
      parent,
      title: sourceTitle(row.title, 'Untitled session', 100),
      profile: null,
      directory: hasWorktree
        ? sourceText(row.worktree)
        : sourceText(row.workspace_root),
      archivedAt: sourceDate(row.archived_at),
      createdAt: sourceDate(row.created_at),
      updatedAt: sourceDate(row.updated_at),
      nativeId,
      hasWorktree,
      branch: sourceText(row.branch, 512),
      provider,
      blocked,
      order: 0,
    };
  };

  const groupCount = Number(
    database
      .prepare(
        'SELECT count(*) AS count FROM projection_projects WHERE deleted_at IS NULL',
      )
      .get()?.count,
  );
  const sessionCount = Number(
    database
      .prepare(
        `
    SELECT count(*) AS count FROM orchestration_v2_projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
    WHERE t.deleted_at IS NULL
  `,
      )
      .get()?.count,
  );
  const counts = { groupCount, sessionCount, profileCount: 0 };
  const build = (
    groupRows: Record<string, SQLOutputValue>[],
    sessionRows: Record<string, SQLOutputValue>[],
  ): ManagerSource => {
    const groups = groupRows.map(project).filter(row => row !== undefined);
    const sessions = sessionRows.map(session).filter(row => row !== undefined);
    const parents = [...new Set(sessionRows.map(row => row.project_id))];
    const direct = new Set(groups.map(group => group.key));
    const contextGroups = parents.length
      ? database
          .prepare(
            projectsSql + ' AND project_id IN (SELECT value FROM json_each(?))',
          )
          .all(JSON.stringify(parents))
          .map(project)
          .filter(
            (row): row is SourceGroup =>
              row !== undefined && !direct.has(row.key),
          )
      : [];
    return {
      ...counts,
      groups,
      sessions,
      contextGroups,
      partial:
        groups.length !== groupRows.length ||
        sessions.length !== sessionRows.length,
    };
  };
  const orderedThreads = ' ORDER BY t.updated_at DESC, t.thread_id';
  const readThreads = (suffix: string, ...values: SQLInputValue[]) =>
    database.prepare(sessionsSql + suffix).all(...values);
  return {
    total: groupCount + sessionCount,
    page(offset: number, limit: number) {
      const groupRows =
        offset < groupCount
          ? database
              .prepare(projectsSql + ' ORDER BY project_id LIMIT ? OFFSET ?')
              .all(limit, offset)
          : [];
      const remaining = limit - groupRows.length;
      const sessionOffset = Math.max(0, offset - groupCount);
      const sessionRows = remaining
        ? readThreads(
            orderedThreads + ' LIMIT ? OFFSET ?',
            remaining,
            sessionOffset,
          )
        : [];
      return build(groupRows, sessionRows);
    },
    selection(keys: ReadonlySet<string>) {
      const values = JSON.stringify([...keys]);
      const groups = database
        .prepare(
          projectsSql +
            ' AND nesvo_project_key(project_id) IN (SELECT value FROM json_each(?)) ORDER BY project_id',
        )
        .all(values);
      return build(
        groups,
        readThreads(
          ' AND nesvo_thread_key(t.thread_id) IN (SELECT value FROM json_each(?))' +
            orderedThreads,
          values,
        ),
      );
    },
  };
}

export async function openT3Source(
  explicitRoot: string | undefined,
  dataDirectory: string,
  signal: AbortSignal,
) {
  const root =
    explicitRoot ?? (process.env.T3CODE_HOME?.trim() || join(homedir(), '.t3'));
  if (!explicitSourceRoot(root))
    throw new ImportSourceError(
      'unavailable',
      'Choose an absolute directory on the selected computer.',
    );
  const path = join(root, 'userdata', 'statev2.sqlite');
  if (!(await sourceFile(path))) return null;
  const canonical = await realpath(root);
  const environment =
    process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const snapshot = await openImportSnapshot(path, dataDirectory, signal);
  try {
    return {
      ...catalog(snapshot.database, environment),
      close: snapshot.close,
    };
  } catch (error) {
    await snapshot.close();
    throw error;
  }
}
