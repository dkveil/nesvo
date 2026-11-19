import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  repositoryIdentitySchema,
  repositoryRemoteSchema,
  repositoryPatternSchema,
  type RepositoryIdentity,
} from '@nesvo/contracts';
import { directoryKey } from '../mcp/scoped-config';
import {
  registeredWorktrees,
  repositoryGitDirectory,
  repositoryRoot,
  runGit,
} from '../workspace/isolation';

export function canonicalRepositoryRemote(value: string): string | null {
  if (value.length > 4096 || /[\s\\?#%\u0000-\u001f\u007f]/u.test(value))
    return null;
  const uri = /^(https|ssh):\/\/([^/]+)\/(.+)$/i.exec(value);
  const scp = /^(?:[^@/:]+@)?([^@/:]+):([^/].*)$/.exec(value);
  let host: string;
  let path: string;
  if (uri) {
    const protocol = uri[1]!.toLowerCase();
    host = uri[2]!.slice(uri[2]!.lastIndexOf('@') + 1).toLowerCase();
    if (protocol === 'https') host = host.replace(/:443$/, '');
    if (protocol === 'ssh') host = host.replace(/:22$/, '');
    path = uri[3]!;
  } else if (scp) {
    host = scp[1]!.toLowerCase();
    path = scp[2]!;
  } else return null;
  const parsed = repositoryRemoteSchema.safeParse(
    host + '/' + path.replace(/\/$/, '').replace(/\.git$/i, ''),
  );
  return parsed.success ? parsed.data : null;
}

export function matchesRepositoryPattern(pattern: string, remote: string) {
  if (
    !repositoryPatternSchema.safeParse(pattern).success ||
    !repositoryRemoteSchema.safeParse(remote).success
  )
    return false;
  const parts = pattern.split('/');
  const target = remote.split('/');
  return (
    parts.length === target.length &&
    parts.every((part, index) => part === '*' || part === target[index])
  );
}

export async function inspectRepositoryIdentity(
  directory: string,
  signal: AbortSignal,
): Promise<RepositoryIdentity> {
  const fallback = await realpath(directory);
  try {
    const root = await realpath(await repositoryRoot(fallback, signal));
    const gitDirectory = await repositoryGitDirectory(root, signal);
    const [registrations, config] = await Promise.all([
      registeredWorktrees(root, signal, gitDirectory),
      runGit({
        args: [
          'config',
          '--file',
          join(gitDirectory, 'config'),
          '--no-includes',
          '--null',
          '--get-regexp',
          String.raw`^(remote\..*\.url|include.*\.path|extensions\.worktreeconfig)$`,
        ],
        cwd: root,
        timeoutMs: 5000,
        signal,
      }),
    ]);
    const checkouts = registrations
      .filter(entry => !entry.prunable)
      .map(entry => entry.worktree);
    if (
      !checkouts.some(checkout => directoryKey(checkout) === directoryKey(root))
    )
      return { status: 'unverified', root };
    if (config.outputTruncated || ![0, 1].includes(config.code ?? -1))
      return { status: 'unverified', root };
    const fields = config.stdout.split('\0').filter(Boolean);
    const urls = fields
      .map(field => {
        const newline = field.indexOf('\n');
        const name = field.slice(0, newline);
        if (
          name === 'extensions.worktreeconfig' &&
          field.slice(newline + 1) === 'false'
        )
          return undefined;
        return /^remote\..+\.url$/.test(name)
          ? canonicalRepositoryRemote(field.slice(newline + 1))
          : null;
      })
      .filter(value => value !== undefined);
    const remotes = new Set(urls);
    const [remote] = remotes;
    const locations = { root, gitDirectory, checkouts };
    if (!remotes.size)
      return repositoryIdentitySchema.parse({ ...locations, status: 'local' });
    if (remotes.size === 1 && remote)
      return repositoryIdentitySchema.parse({
        ...locations,
        status: 'remote',
        remote,
      });
    return repositoryIdentitySchema.parse({
      ...locations,
      status: 'ambiguous',
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: 'unverified', root: fallback };
  }
}

export async function hasRepositoryMarker(root: string) {
  try {
    await lstat(join(root, '.git'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}
