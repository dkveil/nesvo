import { z } from 'zod';
import {
  parsePullRequestUrl,
  type PullRequestReference,
  type TrackedRepository,
} from '@nesvo/contracts';
import { redactLogMessage } from '../log-redaction';
import type { GitHubCli } from '../process/github-cli';
import { check, checkSchema, shaSchema } from '../pull-request-data';
import { readGitHubFetchRemoteEntries, runGit } from '../workspace/isolation';

const openPullRequests = z
  .array(
    z.object({
      url: z.url(),
      headRefName: z.string().min(1).max(255),
      headRefOid: shaSchema,
      statusCheckRollup: z.array(checkSchema).max(500).nullable(),
    }),
  )
  .max(30);

export type RedCiHead = {
  key: string;
  reference: PullRequestReference;
  directory: string;
  sha: string;
  context: string;
};

export class RedCiPoll {
  constructor(
    private readonly cli: Pick<GitHubCli, 'run' | 'json'>,
    private readonly repositories: () => TrackedRepository[],
  ) {}

  async next(
    seen: (key: string) => boolean,
    signal: AbortSignal,
  ): Promise<RedCiHead | undefined> {
    let failure: unknown;
    for (const { repository, directory } of this.repositories()) {
      signal.throwIfAborted();
      if (!directory) continue;
      try {
        const rows = await this.cli.json(
          openPullRequests,
          [
            'pr',
            'list',
            '--repo',
            repository,
            '--state',
            'open',
            '--author',
            '@me',
            '--limit',
            '30',
            '--json',
            'url,headRefName,headRefOid,statusCheckRollup',
          ],
          { signal, maxOutputBytes: 512 * 1024 },
        );
        for (const row of rows) {
          const reference = parsePullRequestUrl(row.url);
          const sha = row.headRefOid;
          if (reference?.repository.toLowerCase() !== repository.toLowerCase())
            continue;
          const key = `${repository.toLowerCase()}#${reference.number}@${sha}`;
          const failures = (row.statusCheckRollup ?? [])
            .map(check)
            .filter(
              entry =>
                entry.status === 'completed' &&
                (entry.conclusion === 'failure' ||
                  entry.conclusion === 'timed-out'),
            );
          if (failures.length === 0 || seen(key)) continue;
          const excerpts = await Promise.all(
            failures
              .slice(0, 3)
              .map(entry => this.excerpt(repository, entry.url, signal)),
          );
          signal.throwIfAborted();
          return {
            key,
            reference,
            directory,
            sha,
            context: JSON.stringify({
              pullRequest: row.url,
              branch: row.headRefName,
              headSha: sha,
              failingJobs: failures.slice(0, 12).map((entry, index) => ({
                name: entry.name,
                logExcerpt: excerpts[index] ?? null,
              })),
            }),
          };
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    return undefined;
  }

  private async excerpt(
    repository: string,
    url: string | null,
    signal: AbortSignal,
  ) {
    if (!url) return null;
    const { origin, pathname } = new URL(url);
    const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(
      pathname,
    );
    if (
      origin !== 'https://github.com' ||
      match?.[1]?.toLowerCase() !== repository.toLowerCase()
    )
      return null;
    try {
      const log = await this.cli.run(
        [
          'run',
          'view',
          match[2]!,
          '--job',
          match[3]!,
          '--repo',
          repository,
          '--log-failed',
        ],
        { signal, maxOutputBytes: 64 * 1024, allowTruncatedOutput: true },
      );
      return log ? redactLogMessage(log).slice(0, 1400) : null;
    } catch {
      return null;
    }
  }
}

export async function prepareCiHead(
  head: RedCiHead,
  directory: string,
  signal: AbortSignal,
) {
  const repository = head.reference.repository;
  const remotes = await readGitHubFetchRemoteEntries(directory, signal);
  const remote = remotes.find(
    candidate =>
      candidate.repository.toLowerCase() === repository.toLowerCase(),
  );
  if (!remote) return false;
  const hasCommit = async () =>
    (
      await runGit({
        args: ['cat-file', '-e', `${head.sha}^{commit}`],
        cwd: directory,
        signal,
        timeoutMs: 10_000,
      })
    ).code === 0;
  if (await hasCommit()) return true;
  const fetched = await runGit({
    args: [
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      '--no-auto-maintenance',
      '--refmap=',
      '--',
      remote.name,
      `refs/pull/${head.reference.number}/head`,
    ],
    cwd: directory,
    signal,
    timeoutMs: 30_000,
  });
  return fetched.code === 0 && (await hasCommit());
}
