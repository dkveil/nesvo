import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeRecipeRepository } from '@nesvo/contracts';

const CONFIG_LIMIT_BYTES = 256 * 1024;

const unquote = (value: string) => {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1')
    : trimmed;
};

export const readRemoteUrls = (gitDirectory: string) => {
  const path = join(gitDirectory, 'config');
  try {
    if (statSync(path).size > CONFIG_LIMIT_BYTES) return [];
    const remotes: { name: string; url: string }[] = [];
    let remote: string | null = null;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const section = /^\s*\[\s*([^\]\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(
        line,
      );
      if (section) {
        remote =
          section[1]!.toLowerCase() === 'remote' && section[2]
            ? section[2]
            : null;
        continue;
      }
      if (remote === null) continue;
      const entry = /^\s*url\s*=\s*(.+)$/i.exec(line);
      const name = remote;
      if (entry && !remotes.some(item => item.name === name))
        remotes.push({ name, url: unquote(entry[1]!) });
    }
    return remotes;
  } catch {
    return [];
  }
};

const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;

export const canonicalRemote = (url: string): string | null => {
  let host: string;
  let path: string;
  const scp = SCP_LIKE.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && scp[1]!.length > 1) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol))
        return null;
      host = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
      path = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  }
  const cleaned = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '');
  if (!host || !cleaned || cleaned.includes('..')) return null;
  return `${host}/${cleaned}`;
};

const pathKey = (directory: string) =>
  process.platform === 'win32' ? directory.toLowerCase() : directory;

export const repositoryCandidates = (
  gitDirectory: string,
  projectDirectory: string,
): WorktreeRecipeRepository[] => {
  const remotes = readRemoteUrls(gitDirectory);
  const preferred = [
    ...remotes.filter(remote => remote.name === 'origin'),
    ...remotes.filter(remote => remote.name !== 'origin'),
  ];
  const remote = preferred
    .map(item => canonicalRemote(item.url))
    .find((value): value is string => !!value);
  return [
    ...(remote
      ? [{ key: remote.toLowerCase(), kind: 'remote' as const, label: remote }]
      : []),
    {
      key: pathKey(projectDirectory),
      kind: 'path' as const,
      label: projectDirectory,
    },
  ];
};
