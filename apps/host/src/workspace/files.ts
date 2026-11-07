import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  workspaceLimits,
  type ListWorkspaceDirectoryInput,
  type ReadWorkspaceFileInput,
  type SearchWorkspaceFilesInput,
  type Session,
  type WorkspaceDirectory,
  type WorkspaceEntry,
  type WorkspaceFile,
  type WorkspaceSearch,
} from '@nesvo/contracts';

const excludedNames = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.cache',
  '.nesvo',
  '.claude',
  '.codex',
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.gnupg',
  '.secrets',
  '.npmrc',
  '.netrc',
  'auth.json',
  'credentials',
  'credentials.json',
]);
const policyDetail =
  'Current workspace. Generated and private entries are excluded; symbolic links are not followed.';

export class WorkspaceError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'not-found' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

class WorkspaceBudgetError extends Error {}

function excluded(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    excludedNames.has(lower) ||
    lower.startsWith('.env') ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(lower) ||
    /\.(?:pem|key|p12|pfx|keystore)$/.test(lower)
  );
}

function pathParts(value: string): string[] {
  if (value === '' || value === '.') return [];
  const parts = value.split('/');
  if (
    isAbsolute(value) ||
    /[\\:\x00-\x1f\x7f]/.test(value) ||
    parts.some(
      part =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(
          part,
        ),
    )
  )
    throw new WorkspaceError(
      'invalid-request',
      'Use a relative workspace path without traversal or device names.',
    );
  if (parts.some(excluded))
    throw new WorkspaceError(
      'invalid-request',
      'This generated or private path is excluded from the file explorer.',
    );
  return parts;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`)
  );
}

function signature(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

function mapError(error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : '';
  return new WorkspaceError(
    code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unavailable',
    code === 'ENOENT' || code === 'ENOTDIR'
      ? 'The workspace path no longer exists. Refresh the file list.'
      : 'The workspace path could not be read. Refresh and try again.',
  );
}

async function withBudget<T>(
  run: (check: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let reason = 'The workspace request exceeded its time limit.';
  const cancel = () => {
    reason = 'The workspace request was cancelled.';
    controller.abort();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(),
    workspaceLimits.milliseconds,
  );
  const check = () => {
    if (controller.signal.aborted) throw new WorkspaceBudgetError(reason);
  };
  let rejectAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new WorkspaceBudgetError(reason));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  try {
    return await Promise.race([run(check), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

async function target(root: string, path: string, check: () => void) {
  check();
  const parts = pathParts(path);
  let current = root;
  let stat = await lstat(current, { bigint: true });
  for (let index = 0; ; index++) {
    check();
    if (stat.isSymbolicLink())
      throw new WorkspaceError(
        'invalid-request',
        'Symbolic links and junctions cannot be opened in the file explorer.',
      );
    if (!stat.isDirectory() && !stat.isFile())
      throw new WorkspaceError(
        'invalid-request',
        'Special files cannot be opened in the file explorer.',
      );
    const canonical = await realpath(current);
    check();
    if (!inside(root, canonical) || !samePath(canonical, resolve(current)))
      throw new WorkspaceError(
        'invalid-request',
        'The path changed or leads outside the session workspace.',
      );
    if (index === parts.length)
      return { path: current, relativePath: parts.join('/'), stat };
    if (!stat.isDirectory())
      throw new WorkspaceError(
        'not-found',
        'The workspace directory no longer exists.',
      );
    current = join(current, parts[index]!);
    stat = await lstat(current, { bigint: true });
  }
}

function order(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.sort((a, b) =>
    a.kind === b.kind
      ? a.path.localeCompare(b.path)
      : a.kind === 'directory'
        ? -1
        : 1,
  );
}

export class WorkspaceFiles {
  constructor(private readonly session: (id: string) => Session | undefined) {}

  private root(sessionId: string): string {
    const session = this.session(sessionId);
    if (!session) throw new WorkspaceError('not-found', 'Session not found.');
    if (!isAbsolute(session.directory))
      throw new WorkspaceError(
        'unavailable',
        'The session workspace is unavailable.',
      );
    return resolve(session.directory);
  }

  async list(
    input: ListWorkspaceDirectoryInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectory> {
    const root = this.root(input.sessionId);
    const path = pathParts(input.path).join('/');
    const entries: WorkspaceEntry[] = [];
    let truncated = false;
    let detail = policyDetail;
    try {
      await withBudget(async check => {
        const directory = await target(root, path, check);
        if (!directory.stat.isDirectory())
          throw new WorkspaceError(
            'invalid-request',
            'Choose a directory to list its files.',
          );
        const handle = await opendir(directory.path, { bufferSize: 32 });
        try {
          let visited = 0;
          while (true) {
            check();
            const entry = await handle.read();
            check();
            if (!entry) break;
            if (
              ++visited > workspaceLimits.visited ||
              entries.length >= workspaceLimits.entries
            ) {
              truncated = true;
              break;
            }
            if (excluded(entry.name) || entry.isSymbolicLink()) continue;
            const relativePath = path ? `${path}/${entry.name}` : entry.name;
            let child;
            try {
              child = await target(root, relativePath, check);
            } catch (error) {
              if (error instanceof WorkspaceBudgetError) throw error;
              truncated = true;
              continue;
            }
            entries.push({
              name: entry.name,
              path: child.relativePath,
              kind: child.stat.isDirectory() ? 'directory' : 'file',
              size: child.stat.isDirectory() ? null : Number(child.stat.size),
            });
          }
        } finally {
          await handle.close();
        }
      }, signal);
    } catch (error) {
      if (!(error instanceof WorkspaceBudgetError)) throw mapError(error);
      truncated = true;
      detail = `${error.message} ${policyDetail}`;
    }
    if (truncated && detail === policyDetail)
      detail = `Some entries were omitted because a limit was reached or a path changed. ${policyDetail}`;
    return {
      sessionId: input.sessionId,
      path,
      entries: order(entries),
      truncated,
      detail,
    };
  }

  async search(
    input: SearchWorkspaceFilesInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearch> {
    const root = this.root(input.sessionId);
    const path = pathParts(input.path).join('/');
    const query = input.query.toLowerCase();
    const matches: WorkspaceEntry[] = [];
    let truncated = false;
    let detail = policyDetail;
    let visited = 0;
    try {
      await withBudget(async check => {
        const visit = async (
          relativePath: string,
          depth: number,
        ): Promise<void> => {
          check();
          if (
            depth > workspaceLimits.depth ||
            visited >= workspaceLimits.visited ||
            matches.length >= workspaceLimits.matches
          ) {
            truncated = true;
            return;
          }
          const directory = await target(root, relativePath, check);
          if (!directory.stat.isDirectory())
            throw new WorkspaceError(
              'invalid-request',
              'Choose a directory to search filenames.',
            );
          const handle = await opendir(directory.path, { bufferSize: 32 });
          try {
            while (true) {
              check();
              const entry = await handle.read();
              check();
              if (!entry) break;
              if (
                ++visited > workspaceLimits.visited ||
                matches.length >= workspaceLimits.matches
              ) {
                truncated = true;
                break;
              }
              if (excluded(entry.name) || entry.isSymbolicLink()) continue;
              const childPath = relativePath
                ? `${relativePath}/${entry.name}`
                : entry.name;
              let child;
              try {
                child = await target(root, childPath, check);
              } catch (error) {
                if (error instanceof WorkspaceBudgetError) throw error;
                truncated = true;
                continue;
              }
              if (
                child.stat.isFile() &&
                childPath.toLowerCase().includes(query)
              )
                matches.push({
                  name: entry.name,
                  path: child.relativePath,
                  kind: child.stat.isDirectory() ? 'directory' : 'file',
                  size: child.stat.isDirectory()
                    ? null
                    : Number(child.stat.size),
                });
              if (child.stat.isDirectory())
                await visit(child.relativePath, depth + 1);
            }
          } finally {
            await handle.close();
          }
        };
        await visit(path, 0);
      }, signal);
    } catch (error) {
      if (!(error instanceof WorkspaceBudgetError)) throw mapError(error);
      truncated = true;
      detail = `${error.message} ${policyDetail}`;
    }
    if (truncated && detail === policyDetail)
      detail = `Search results are incomplete because a limit was reached or a path changed. ${policyDetail}`;
    return {
      sessionId: input.sessionId,
      path,
      query: input.query,
      matches: order(matches),
      truncated,
      detail,
    };
  }

  async read(
    input: ReadWorkspaceFileInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceFile> {
    const root = this.root(input.sessionId);
    try {
      return await withBudget(async check => {
        const file = await target(root, input.path, check);
        if (!file.stat.isFile())
          throw new WorkspaceError(
            'invalid-request',
            'Choose a regular file to preview.',
          );
        const base = {
          sessionId: input.sessionId,
          path: file.relativePath,
          size: Number(file.stat.size),
        };
        if (file.stat.size > BigInt(workspaceLimits.previewBytes))
          return {
            ...base,
            status: 'too-large',
            text: null,
            truncated: true,
            detail: 'This file exceeds the 256 KiB preview limit.',
          };
        const handle = await open(
          file.path,
          constants.O_RDONLY |
            (process.platform === 'win32'
              ? 0
              : constants.O_NOFOLLOW | constants.O_NONBLOCK),
        );
        let bytes: Buffer;
        try {
          check();
          const before = await handle.stat({ bigint: true });
          if (!before.isFile() || signature(before) !== signature(file.stat))
            throw new WorkspaceError(
              'unavailable',
              'The file changed while it was opened. Refresh the preview.',
            );
          const buffer = Buffer.alloc(Number(before.size) + 1);
          let offset = 0;
          while (offset < buffer.length) {
            check();
            const result = await handle.read(
              buffer,
              offset,
              buffer.length - offset,
              null,
            );
            check();
            if (!result.bytesRead) break;
            offset += result.bytesRead;
          }
          const after = await handle.stat({ bigint: true });
          const current = await target(root, file.relativePath, check);
          if (
            offset !== Number(before.size) ||
            signature(before) !== signature(after) ||
            signature(after) !== signature(current.stat)
          )
            throw new WorkspaceError(
              'unavailable',
              'The file changed during preview. Refresh and try again.',
            );
          bytes = buffer.subarray(0, offset);
        } finally {
          await handle.close();
        }
        let text: string | null = null;
        if (
          !bytes.some(
            byte => byte === 0 || byte < 9 || (byte > 13 && byte < 32),
          )
        ) {
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            text = null;
          }
        }
        return {
          ...base,
          status: text === null ? 'binary' : 'text',
          text,
          truncated: false,
          detail:
            text === null
              ? 'Binary or non-UTF-8 files do not have a text preview.'
              : 'Current workspace contents, separate from saved review versions.',
        };
      }, signal);
    } catch (error) {
      if (error instanceof WorkspaceBudgetError)
        throw new WorkspaceError('unavailable', error.message);
      throw mapError(error);
    }
  }
}
