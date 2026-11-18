import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  parseGitHubRepository,
  trackedRepositoryLimits as limits,
  trackedRepositorySchema,
  type addTrackedRepositorySchema,
  type listTrackedPullRequestsSchema,
  type PullRequestReference,
  type TrackedPullRequestList,
  type TrackedRepository,
  type TrackedRepositorySuggestion,
} from '@nesvo/contracts';
import type { z } from 'zod';
import { PullRequestError } from './process/github-cli';
import type { PullRequests } from './pull-requests';
import { resolveFolder } from './workspace/folder';
import { readGitHubFetchRemotes } from './workspace/isolation';

type Row = Record<string, SQLOutputValue>;

type SessionFolder = {
  directory: string;
  worktree?: { projectDirectory: string } | null;
  pullRequest?: PullRequestReference | null;
};

type TrackedRepositoriesParams = {
  database: DatabaseSync;
  pullRequests: Pick<PullRequests, 'canonicalRepository' | 'listRepository'>;
  sessions: () => SessionFolder[];
  signal: AbortSignal;
};

const LIST_CONCURRENCY = 4;
const SUGGESTED_FOLDERS = 12;
const REMOTE_READ_TIMEOUT_MS = 10_000;

export const installTrackedRepositoryTables = (database: DatabaseSync) => {
  database.exec(
    'CREATE TABLE IF NOT EXISTS tracked_repositories (id TEXT PRIMARY KEY, repository TEXT NOT NULL COLLATE NOCASE UNIQUE, directory TEXT, position INTEGER NOT NULL, added_at TEXT NOT NULL)',
  );
};

const toTracked = (row: Row): TrackedRepository =>
  trackedRepositorySchema.parse({
    id: row.id,
    repository: row.repository,
    directory: row.directory ?? null,
    addedAt: row.added_at,
  });

const sameRepository = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();

const mapLimited = async <T, R>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
};

export class TrackedRepositories {
  private readonly database: DatabaseSync;
  private readonly pullRequests: TrackedRepositoriesParams['pullRequests'];
  private readonly sessions: () => SessionFolder[];
  private readonly signal: AbortSignal;

  constructor({
    database,
    pullRequests,
    sessions,
    signal,
  }: TrackedRepositoriesParams) {
    this.database = database;
    this.pullRequests = pullRequests;
    this.sessions = sessions;
    this.signal = signal;
  }

  list(): TrackedRepository[] {
    return this.database
      .prepare(
        'SELECT id, repository, directory, added_at FROM tracked_repositories ORDER BY position, added_at, id',
      )
      .all()
      .map(toTracked);
  }

  async add(
    input: z.output<typeof addTrackedRepositorySchema>,
  ): Promise<TrackedRepository[]> {
    const parsed = parseGitHubRepository(input.repository);
    if (!parsed)
      throw new PullRequestError(
        'invalid-request',
        'Use owner/name or a GitHub repository link.',
      );
    const repository = await this.pullRequests.canonicalRepository(parsed);
    const directory = input.directory
      ? await this.checkout(input.directory, repository)
      : null;
    const existing = this.list();
    const tracked = existing.find(item =>
      sameRepository(item.repository, repository),
    );
    if (tracked) {
      this.database
        .prepare(
          'UPDATE tracked_repositories SET repository = ?, directory = COALESCE(?, directory) WHERE id = ?',
        )
        .run(repository, directory, tracked.id);
      return this.list();
    }
    if (existing.length >= limits.repositories)
      throw new PullRequestError(
        'invalid-request',
        `Track up to ${limits.repositories} repositories on one computer.`,
      );
    this.database
      .prepare(
        'INSERT INTO tracked_repositories (id, repository, directory, position, added_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM tracked_repositories), ?) ON CONFLICT(repository) DO UPDATE SET directory = COALESCE(excluded.directory, directory)',
      )
      .run(randomUUID(), repository, directory, new Date().toISOString());
    return this.list();
  }

  remove(id: string): TrackedRepository[] {
    this.database
      .prepare('DELETE FROM tracked_repositories WHERE id = ?')
      .run(id);
    return this.list();
  }

  reorder(ids: string[]): TrackedRepository[] {
    const current = this.list();
    const known = new Set(current.map(item => item.id));
    if (ids.length !== current.length || ids.some(id => !known.has(id)))
      throw new PullRequestError(
        'invalid-request',
        'The tracked repositories changed. Refresh and try again.',
      );
    const update = this.database.prepare(
      'UPDATE tracked_repositories SET position = ? WHERE id = ?',
    );
    this.database.exec('BEGIN IMMEDIATE');
    try {
      ids.forEach((id, position) => update.run(position, id));
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.list();
  }

  async suggestions(): Promise<TrackedRepositorySuggestion[]> {
    const tracked = this.list().map(item => item.repository.toLowerCase());
    const sessions = this.sessions();
    const folders = [
      ...new Set(
        sessions
          .map(
            session => session.worktree?.projectDirectory ?? session.directory,
          )
          .filter(folder => isAbsolute(folder)),
      ),
    ].slice(0, SUGGESTED_FOLDERS);
    const remotes = await mapLimited(
      folders,
      LIST_CONCURRENCY,
      async folder => {
        try {
          return await readGitHubFetchRemotes(
            folder,
            AbortSignal.any([
              this.signal,
              AbortSignal.timeout(REMOTE_READ_TIMEOUT_MS),
            ]),
          );
        } catch {
          return [];
        }
      },
    );
    const suggestions = new Map<string, TrackedRepositorySuggestion>();
    const suggest = (suggestion: TrackedRepositorySuggestion) => {
      const key = suggestion.repository.toLowerCase();
      if (tracked.includes(key) || suggestions.has(key)) return;
      if (
        parseGitHubRepository(suggestion.repository) !== suggestion.repository
      )
        return;
      suggestions.set(key, suggestion);
    };
    folders.forEach((folder, index) => {
      for (const repository of remotes[index] ?? [])
        suggest({ repository, directory: folder, source: 'session-folder' });
    });
    for (const session of sessions)
      if (session.pullRequest)
        suggest({
          repository: session.pullRequest.repository,
          directory: null,
          source: 'pull-request',
        });
    return [...suggestions.values()].slice(0, limits.suggestions);
  }

  async pullRequestLists(
    input: z.output<typeof listTrackedPullRequestsSchema>,
  ): Promise<TrackedPullRequestList[]> {
    return mapLimited(
      this.list(),
      LIST_CONCURRENCY,
      async (tracked): Promise<TrackedPullRequestList> => {
        try {
          const list = await this.pullRequests.listRepository(
            tracked.repository,
            input.scope,
            input.query,
            limits.itemsPerRepository,
          );
          return {
            status: 'ready',
            trackedId: tracked.id,
            repository: tracked.repository,
            items: list.items,
            truncated: list.truncated,
          };
        } catch (error) {
          return {
            status: 'error',
            trackedId: tracked.id,
            repository: tracked.repository,
            code:
              error instanceof PullRequestError ? error.code : 'unavailable',
            message:
              error instanceof PullRequestError
                ? error.message.slice(0, 1000)
                : 'The pull requests could not be listed.',
          };
        }
      },
    );
  }

  private async checkout(directory: string, repository: string) {
    const folder = await resolveFolder(directory, this.signal);
    const remotes = await readGitHubFetchRemotes(
      folder,
      AbortSignal.any([
        this.signal,
        AbortSignal.timeout(REMOTE_READ_TIMEOUT_MS),
      ]),
    ).catch(() => []);
    if (!remotes.some(remote => sameRepository(remote, repository)))
      throw new PullRequestError(
        'invalid-request',
        `This folder is not a checkout of ${repository}. Choose a folder whose Git remote points to it.`,
      );
    return folder;
  }
}
