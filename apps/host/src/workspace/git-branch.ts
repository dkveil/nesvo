import { open, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { GitBranch } from '@nesvo/contracts';

const maxPointerBytes = 4096;
const maxParentLevels = 256;
const noBranch: GitBranch = { kind: 'none' };

async function readSmallFile(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > maxPointerBytes) return null;
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(maxPointerBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxPointerBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function findGitDirectory(start: string): Promise<string | null> {
  let current = resolve(start);
  for (let level = 0; level < maxParentLevels; level++) {
    const marker = join(current, '.git');
    const info = await stat(marker).catch(() => null);
    if (info?.isDirectory()) return marker;
    if (info?.isFile()) {
      const pointer = /^gitdir:[ \t]*(\S.*?)[ \t]*$/m.exec(
        (await readSmallFile(marker)) ?? '',
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

export async function readGitBranch(directory: string): Promise<GitBranch> {
  const gitDirectory = await findGitDirectory(directory);
  if (!gitDirectory) return noBranch;
  const head = await readSmallFile(join(gitDirectory, 'HEAD'));
  return head === null ? noBranch : parseGitHead(head);
}
