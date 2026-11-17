import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { GitBranch } from '@nesvo/contracts';

const BRANCH_READ_TIMEOUT_MS = 2000;
const MAX_READER_OUTPUT_BYTES = 16 * 1024;
const MAX_LIVE_READERS = 4;
let liveReaders = 0;
const noBranch: GitBranch = { kind: 'none' };

export class GitBranchError extends Error {
  readonly code = 'unavailable';
}

function readGitHeadInChild(): void {
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const maxBytes = 4096;
  const flags =
    fs.constants.O_RDONLY |
    (process.platform === 'win32'
      ? 0
      : fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
  const readSmallFile = (file: string): string | null => {
    let descriptor: number | null = null;
    try {
      if (!fs.statSync(file).isFile()) return null;
      descriptor = fs.openSync(file, flags);
      const info = fs.fstatSync(descriptor);
      if (!info.isFile() || info.size > maxBytes) return null;
      const buffer = Buffer.alloc(maxBytes);
      const bytes = fs.readSync(descriptor, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytes).toString('utf8');
    } catch {
      return null;
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
    }
  };
  const findGitDirectory = (
    start: string,
  ): { directory: string; worktree: string | null } | null => {
    let current = path.resolve(start);
    for (let level = 0; level < 256; level++) {
      const marker = path.join(current, '.git');
      const info = fs.statSync(marker, { throwIfNoEntry: false });
      if (info?.isDirectory()) return { directory: marker, worktree: null };
      if (info?.isFile()) {
        const pointer = /^gitdir:[ \t]*(\S.*?)[ \t]*$/m.exec(
          readSmallFile(marker) ?? '',
        )?.[1];
        if (!pointer) return null;
        const directory = path.resolve(current, pointer);
        const linked =
          path.basename(path.dirname(directory)) === 'worktrees'
            ? path.basename(directory)
            : '';
        return { directory, worktree: linked || null };
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
    return null;
  };
  const folder = process.argv[1] ?? '';
  let head: string | null = null;
  let worktree: string | null = null;
  try {
    const found = findGitDirectory(folder);
    head = found ? readSmallFile(path.join(found.directory, 'HEAD')) : null;
    worktree = found?.worktree ?? null;
  } catch {
    head = null;
    worktree = null;
  }
  process.stdout.write(JSON.stringify({ head, worktree }));
}

function parseGitHead(content: string, worktree: string | null): GitBranch {
  const head = content.trim();
  const name = /^ref:[ \t]*refs\/heads\/([^\s\p{Cc}\p{Cf}]+)$/u.exec(head)?.[1];
  if (name && name.length <= 255) return { kind: 'branch', name, worktree };
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head))
    return { kind: 'detached', sha: head.slice(0, 7), worktree };
  return noBranch;
}

function readerArguments(directory: string): string[] {
  const override = process.env.NESVO_GIT_HEAD_READER;
  if (override && !isAbsolute(override))
    throw new Error('NESVO_GIT_HEAD_READER must be an absolute path.');
  return override
    ? [override, directory]
    : ['-e', `(${readGitHeadInChild.toString()})()`, '--', directory];
}

function readerEnvironment(): NodeJS.ProcessEnv {
  return {
    ELECTRON_RUN_AS_NODE: '1',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
}

export function readGitBranch(
  directory: string,
  signal: AbortSignal,
): Promise<GitBranch> {
  signal.throwIfAborted();
  if (liveReaders >= MAX_LIVE_READERS)
    return Promise.reject(
      new GitBranchError('Too many Git branch reads are stuck.'),
    );
  const child = spawn(process.execPath, readerArguments(directory), {
    env: readerEnvironment(),
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  liveReaders++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    liveReaders--;
  };
  child.once('exit', release);
  child.once('error', release);
  return new Promise<GitBranch>((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (result: GitBranch | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cutOff);
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const cutOff = () => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.unref();
      finish(new GitBranchError('The Git branch could not be read in time.'));
    };
    const timer = setTimeout(cutOff, BRANCH_READ_TIMEOUT_MS);
    signal.addEventListener('abort', cutOff, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_READER_OUTPUT_BYTES) cutOff();
    });
    child.once('error', () =>
      finish(new GitBranchError('The Git branch could not be read.')),
    );
    child.once('close', code => {
      const report = code === 0 ? parsedReport(output) : undefined;
      if (report === undefined)
        finish(new GitBranchError('The Git branch could not be read.'));
      else
        finish(
          report.head === null
            ? noBranch
            : parseGitHead(report.head, report.worktree),
        );
    });
  });
}

function parsedReport(
  output: string,
): { head: string | null; worktree: string | null } | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (value === null || typeof value !== 'object' || !('head' in value))
      return undefined;
    if (typeof value.head !== 'string' && value.head !== null) return undefined;
    const worktree =
      'worktree' in value &&
      typeof value.worktree === 'string' &&
      value.worktree.length > 0 &&
      value.worktree.length <= 255 &&
      !/[\p{Cc}\p{Cf}]/u.test(value.worktree)
        ? value.worktree
        : null;
    return { head: value.head, worktree };
  } catch {
    return undefined;
  }
}
