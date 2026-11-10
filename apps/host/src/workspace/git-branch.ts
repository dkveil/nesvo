import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { GitBranch } from '@nesvo/contracts';

const maxPointerBytes = 4096;
const maxParentLevels = 256;
const BRANCH_READ_TIMEOUT_MS = 2000;
const noBranch: GitBranch = { kind: 'none' };
const readFlags =
  constants.O_RDONLY |
  (process.platform === 'win32' ? 0 : constants.O_NONBLOCK);

async function readSmallFile(
  path: string,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  const handle = await open(path, readFlags).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    signal.throwIfAborted();
    if (!info.isFile() || info.size > maxPointerBytes) return null;
    const buffer = Buffer.alloc(maxPointerBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxPointerBytes, 0);
    signal.throwIfAborted();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  } finally {
    await handle.close();
  }
}

async function findGitDirectory(
  start: string,
  signal: AbortSignal,
): Promise<string | null> {
  let current = resolve(start);
  for (let level = 0; level < maxParentLevels; level++) {
    signal.throwIfAborted();
    const marker = join(current, '.git');
    const info = await stat(marker).catch(() => null);
    if (info?.isDirectory()) return marker;
    if (info?.isFile()) {
      const pointer = /^gitdir:[ \t]*(\S.*?)[ \t]*$/m.exec(
        (await readSmallFile(marker, signal)) ?? '',
      )?.[1];
      return pointer ? resolve(current, pointer) : null;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function parseGitHead(content: string): GitBranch {
  const head = content.trim();
  const name = /^ref:[ \t]*refs\/heads\/(\S+)$/.exec(head)?.[1];
  if (name && name.length <= 255) return { kind: 'branch', name };
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head))
    return { kind: 'detached', sha: head.slice(0, 7) };
  return noBranch;
}

export async function readGitBranch(
  directory: string,
  signal: AbortSignal,
): Promise<GitBranch> {
  const scoped = AbortSignal.any([
    signal,
    AbortSignal.timeout(BRANCH_READ_TIMEOUT_MS),
  ]);
  const gitDirectory = await findGitDirectory(directory, scoped);
  if (!gitDirectory) return noBranch;
  const head = await readSmallFile(join(gitDirectory, 'HEAD'), scoped);
  return head === null ? noBranch : parseGitHead(head);
}
