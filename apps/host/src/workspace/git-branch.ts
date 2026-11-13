import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { GitBranch } from '@nesvo/contracts';

const BRANCH_READ_TIMEOUT_MS = 2000;
const MAX_READER_OUTPUT_BYTES = 16 * 1024;
const noBranch: GitBranch = { kind: 'none' };

export class GitBranchError extends Error {
  code: 'invalid-directory' | 'unavailable';

  constructor(code: 'invalid-directory' | 'unavailable', message: string) {
    super(message);
    this.code = code;
  }
}

function readGitHeadInChild(): void {
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const maxBytes = 4096;
  const flags =
    fs.constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK);
  const readSmallFile = (file: string): string | null => {
    let descriptor: number | null = null;
    try {
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
  const findGitDirectory = (start: string): string | null => {
    let current = path.resolve(start);
    for (let level = 0; level < 256; level++) {
      const marker = path.join(current, '.git');
      const info = fs.statSync(marker, { throwIfNoEntry: false });
      if (info?.isDirectory()) return marker;
      if (info?.isFile()) {
        const pointer = /^gitdir:[ \t]*(\S.*?)[ \t]*$/m.exec(
          readSmallFile(marker) ?? '',
        )?.[1];
        return pointer ? path.resolve(current, pointer) : null;
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
    return null;
  };
  const resolveFolder = (requested: string): string | null => {
    try {
      if (!path.isAbsolute(requested) || !fs.statSync(requested).isDirectory())
        return null;
      return fs.realpathSync(requested);
    } catch {
      return null;
    }
  };
  const folder = resolveFolder(process.argv[1] ?? '');
  if (folder === null) {
    process.stdout.write(JSON.stringify({ invalid: true }));
    return;
  }
  let head: string | null = null;
  try {
    const gitDirectory = findGitDirectory(folder);
    head = gitDirectory ? readSmallFile(path.join(gitDirectory, 'HEAD')) : null;
  } catch {
    head = null;
  }
  process.stdout.write(JSON.stringify({ head }));
}

function parseGitHead(content: string): GitBranch {
  const head = content.trim();
  const name = /^ref:[ \t]*refs\/heads\/(\S+)$/.exec(head)?.[1];
  if (name && name.length <= 255) return { kind: 'branch', name };
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head))
    return { kind: 'detached', sha: head.slice(0, 7) };
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
  const child = spawn(process.execPath, readerArguments(directory), {
    env: readerEnvironment(),
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
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
      finish(
        new GitBranchError(
          'unavailable',
          'The Git branch could not be read in time.',
        ),
      );
    };
    const timer = setTimeout(cutOff, BRANCH_READ_TIMEOUT_MS);
    signal.addEventListener('abort', cutOff, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_READER_OUTPUT_BYTES) cutOff();
    });
    child.once('error', () =>
      finish(
        new GitBranchError('unavailable', 'The Git branch could not be read.'),
      ),
    );
    child.once('close', code => {
      const report = code === 0 ? parsedReport(output) : undefined;
      if (report === undefined)
        finish(
          new GitBranchError(
            'unavailable',
            'The Git branch could not be read.',
          ),
        );
      else if ('invalid' in report)
        finish(
          new GitBranchError(
            'invalid-directory',
            'The directory does not exist or cannot be accessed.',
          ),
        );
      else finish(report.head === null ? noBranch : parseGitHead(report.head));
    });
  });
}

function parsedReport(
  output: string,
): { invalid: true } | { head: string | null } | undefined {
  try {
    const value: unknown = JSON.parse(output);
    if (value === null || typeof value !== 'object') return undefined;
    if ('invalid' in value && value.invalid === true) return { invalid: true };
    if (!('head' in value)) return undefined;
    return typeof value.head === 'string' || value.head === null
      ? { head: value.head }
      : undefined;
  } catch {
    return undefined;
  }
}
