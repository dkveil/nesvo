import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Provider } from '@nesvo/contracts';
import {
  ImportSourceError,
  sourceChanged,
  sourceFile,
  withImportSnapshot,
} from './import-snapshot';
import {
  explicitSourceRoot,
  managerRowLimit,
  sourceDate,
  sourceKey,
  sourceText,
  sourceTitle,
  type ManagerSource,
  type SourceGroup,
  type SourceSession,
} from './manager-source';

const profileLimit = 32;
const record = z.record(z.string(), z.unknown());
type Row = z.infer<typeof record>;
type Profile = {
  instances: Row[];
  groups: Row[];
  sessionCount: number;
  groupCount: number;
  legacy: boolean;
};
type DeckResult = ManagerSource | { roots: string[] } | null;

const order = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(0, Math.min(10_000, value))
    : 0;

function inspect(db: DatabaseSync): Profile {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('instances', 'groups')",
    )
    .all();
  if (tables.length !== 2)
    throw new ImportSourceError(
      'unsupported',
      'This Agent Deck profile uses an unsupported database schema.',
    );
  const instances = db
    .prepare(
      `
    SELECT id, substr(title, 1, 100) AS title, tool, status, group_path, sort_order,
      archived_at, created_at, last_accessed, substr(project_path, 1, 4097) AS project_path,
      substr(worktree_path, 1, 4097) AS worktree_path, worktree_repo,
      substr(worktree_branch, 1, 513) AS worktree_branch, substr(tool_data, 1, 65537) AS tool_data
    FROM instances ORDER BY sort_order, id LIMIT ?
  `,
    )
    .all(managerRowLimit);
  const groups = db
    .prepare(
      `
    SELECT path, substr(name, 1, 80) AS name, sort_order,
      substr(default_path, 1, 4097) AS default_path
    FROM groups ORDER BY sort_order, path LIMIT ?
  `,
    )
    .all(managerRowLimit);
  const sessionCount = Number(
    db.prepare('SELECT count(*) AS count FROM instances').get()?.count,
  );
  const groupCount = Number(
    db.prepare('SELECT count(*) AS count FROM groups').get()?.count,
  );
  return { instances, groups, sessionCount, groupCount, legacy: false };
}

async function readLegacy(
  path: string,
  signal: AbortSignal,
): Promise<Profile | null> {
  const before = await sourceFile(path);
  if (!before) return null;
  if (before.size > 8n * 1024n * 1024n)
    throw new ImportSourceError(
      'unavailable',
      'An Agent Deck JSON store exceeds the import read limit.',
    );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const bytes = Buffer.alloc(Number(before.size));
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) throw sourceChanged();
      offset += bytesRead;
    }
    const after = await sourceFile(path);
    if (
      !after ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw sourceChanged();
    const data = z
      .object({
        instances: z.array(z.unknown()),
        groups: z.array(z.unknown()).default([]),
      })
      .parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
    return {
      instances: data.instances
        .slice(0, managerRowLimit)
        .map(value => record.parse(value)),
      groups: data.groups
        .slice(0, managerRowLimit)
        .map(value => record.parse(value)),
      sessionCount: data.instances.length,
      groupCount: data.groups.length,
      legacy: true,
    };
  } finally {
    await file.close();
  }
}

function groupPath(value: unknown) {
  const path = sourceText(value, 1024);
  if (!path) return [];
  const parts = path.split('/');
  return parts.every(part => part.trim() && part !== '.' && part !== '..')
    ? parts
    : [];
}

function normalize(profile: Profile, root: string, name: string) {
  const label = sourceTitle(name, 'Default profile', 100);
  const key = (kind: string, id: string) =>
    sourceKey('agent-deck', root, name, kind, id);
  const groups = new Map<string, SourceGroup>();
  const rows = new Map(
    profile.groups.flatMap(row => {
      const parts = groupPath(row.path);
      return parts.length ? [[parts.join('/'), row] as const] : [];
    }),
  );
  const ensure = (parts: string[]) => {
    const chunks =
      parts.length > 3
        ? [...parts.slice(0, 2), parts.slice(2).join('/')]
        : parts;
    let parent: string | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const path = chunks.slice(0, index + 1).join('/');
      const id = key('group', path);
      if (!groups.has(id)) {
        const row = rows.get(path);
        const title =
          chunk.split('/').length > 1 ? chunk : (row?.name ?? chunk);
        groups.set(id, {
          kind: 'group',
          key: id,
          parent,
          profile: label,
          archivedAt: null,
          title: sourceTitle(title, 'Untitled group', 80),
          directory: sourceText(row?.default_path),
          order: order(row?.[profile.legacy ? 'order' : 'sort_order']),
        });
      }
      parent = id;
    }
    return parent;
  };
  for (const path of rows.keys()) ensure(path.split('/'));
  const sessions = profile.instances.flatMap((row): SourceSession[] => {
    const id = sourceText(row.id, 512);
    if (!id) return [];
    const parent = ensure(groupPath(row.group_path));
    const provider: Provider | null =
      row.tool === 'claude'
        ? 'Claude Code'
        : row.tool === 'codex'
          ? 'Codex'
          : null;
    const tool = profile.legacy ? row : toolData(row.tool_data);
    const nativeId = sourceText(
      provider === 'Claude Code'
        ? tool?.claude_session_id
        : tool?.codex_session_id,
      36,
    );
    const hasWorktree =
      typeof row.worktree_path === 'string' && row.worktree_path !== '';
    let blocked: string | null = null;
    if (!provider) blocked = 'This provider cannot be imported.';
    else if (!tool) blocked = 'The provider record could not be read.';
    else if (tool.ssh_host || tool.ssh_remote_path)
      blocked = 'This session belongs to an SSH target.';
    else if (tool.sandbox_container || tool.sandbox || tool.sandbox_json)
      blocked = 'This session belongs to a container.';
    else if (
      !['idle', 'stopped', 'error', 'archived'].includes(String(row.status))
    )
      blocked = 'Agent Deck does not report this session as settled.';
    else if (provider === 'Claude Code' && tool.claude_session_id_unverified)
      blocked = 'The Claude Code conversation ID was unverified.';
    else if (!z.uuid().safeParse(nativeId).success)
      blocked = 'The native provider reference could not be verified.';
    return [
      {
        kind: 'session',
        key: key('session', id),
        parent,
        title: sourceTitle(row.title, 'Untitled session', 100),
        profile: label,
        provider,
        nativeId,
        hasWorktree,
        blocked,
        directory: sourceText(
          hasWorktree ? row.worktree_path : row.project_path,
        ),
        branch: sourceText(row.worktree_branch, 512),
        archivedAt: sourceDate(row.archived_at),
        createdAt: sourceDate(row.created_at),
        updatedAt: sourceDate(
          profile.legacy ? row.last_accessed_at : row.last_accessed,
        ),
        order: order(row[profile.legacy ? 'order' : 'sort_order']),
      },
    ];
  });

  const sorted = [...groups.values()].sort(
    (a, b) =>
      a.order - b.order ||
      a.title.localeCompare(b.title) ||
      a.key.localeCompare(b.key),
  );
  const children = new Map<string | null, SourceGroup[]>();
  for (const group of sorted) {
    const siblings = children.get(group.parent) ?? [];
    siblings.push(group);
    children.set(group.parent, siblings);
  }
  const ordered = (parent: string | null): SourceGroup[] =>
    (children.get(parent) ?? []).flatMap(group => [
      group,
      ...ordered(group.key),
    ]);
  return { groups: ordered(null), sessions };
}

function toolData(value: unknown) {
  if (typeof value !== 'string' || value.length > 65536) return null;
  try {
    return record.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

async function readRoot(
  root: string,
  dataDirectory: string,
  signal: AbortSignal,
): Promise<ManagerSource | null> {
  let directory;
  try {
    directory = await opendir(join(root, 'profiles'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const environment = await realpath(root);
  const result: ManagerSource = {
    groups: [],
    sessions: [],
    profileCount: 0,
    groupCount: 0,
    sessionCount: 0,
  };
  const names: string[] = [];
  let seen = 0;
  for await (const entry of directory) {
    signal.throwIfAborted();
    if (++seen > 128) {
      result.partial = true;
      break;
    }
    if (entry.isDirectory() && !entry.name.startsWith('.'))
      names.push(entry.name);
  }
  result.partial ||= names.length > profileLimit;
  let skipped = 0;
  for (const name of names.sort().slice(0, profileLimit)) {
    const folder = join(root, 'profiles', name);
    const db = join(folder, 'state.db');
    try {
      const profile = (await sourceFile(db))
        ? await withImportSnapshot(db, dataDirectory, signal, inspect)
        : await readLegacy(join(folder, 'sessions.json'), signal);
      if (!profile) continue;
      const { groups, sessions } = normalize(profile, environment, name);
      result.profileCount++;
      result.groupCount += Math.max(profile.groupCount, groups.length);
      result.sessionCount += profile.sessionCount;
      result.groups.push(
        ...groups.slice(0, Math.max(0, managerRowLimit - result.groups.length)),
      );
      result.sessions.push(
        ...sessions.slice(
          0,
          Math.max(0, managerRowLimit - result.sessions.length),
        ),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ImportSourceError && error.status === 'retry')
        throw error;
      skipped++;
    }
  }
  if (!result.profileCount && skipped)
    throw new ImportSourceError(
      'unavailable',
      'The Agent Deck profile stores could not be read.',
    );
  result.partial ||= skipped > 0;
  return result;
}

export async function readAgentDeckSource(
  explicitRoot: string | undefined,
  dataDirectory: string,
  signal: AbortSignal,
): Promise<DeckResult> {
  const fixture =
    process.env.NESVO_TEST_MODE === '1'
      ? process.env.NESVO_TEST_AGENT_DECK_ROOT
      : undefined;
  if (!fixture && process.platform !== 'linux' && process.platform !== 'darwin')
    throw new ImportSourceError(
      'unsupported',
      'Agent Deck requires a Nesvo host on Linux, macOS or WSL.',
    );
  const root = explicitRoot ?? fixture;
  if (root) {
    if (!explicitSourceRoot(root) || (fixture && root !== fixture))
      throw new ImportSourceError(
        'unavailable',
        'Choose an absolute data directory on the selected computer.',
      );
    return readRoot(root, dataDirectory, signal);
  }
  const xdgHome = process.env.XDG_DATA_HOME;
  const xdg = join(
    xdgHome && isAbsolute(xdgHome)
      ? xdgHome
      : join(homedir(), '.local', 'share'),
    'agent-deck',
  );
  const legacy = join(homedir(), '.agent-deck');
  if (await sourceFile(join(xdg, 'profiles', '.active-root')))
    return readRoot(xdg, dataDirectory, signal);
  const inspectRoot = async (path: string) => {
    try {
      return await readRoot(path, dataDirectory, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ImportSourceError && error.status === 'retry')
        throw error;
      return 'unreadable' as const;
    }
  };
  const current = await inspectRoot(xdg);
  const previous = await inspectRoot(legacy);
  if (!current || !previous) {
    const available = current ?? previous;
    if (available === 'unreadable')
      throw new ImportSourceError(
        'unavailable',
        'The Agent Deck data directory could not be read.',
      );
    return available;
  }
  if (current === 'unreadable' && previous !== 'unreadable')
    return { ...previous, partial: true };
  if (previous === 'unreadable' && current !== 'unreadable')
    return { ...current, partial: true };
  if (current !== 'unreadable' && previous !== 'unreadable') {
    if (current.sessionCount && !previous.sessionCount && !previous.partial)
      return current;
    if (previous.sessionCount && !current.sessionCount && !current.partial)
      return previous;
  }
  return { roots: [legacy, xdg] };
}
