import { lstat, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  sessionChangeLimits,
  type ReadSessionChangePatchInput,
  type ReadSessionChangesInput,
  type Session,
  type SessionChangePatch,
  type SessionChangeScope,
  type SessionChangeSet,
  type SessionChangedFile,
  type SessionChanges,
} from '@nesvo/contracts';
import { WorkspaceIsolationError, runGit } from './isolation';

const GIT_TIMEOUT_MS = 10_000;
const MAX_LIST_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COUNTED_FILE_BYTES = 1024 * 1024;
const MAX_COUNTED_TOTAL_BYTES = 8 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GLOBAL_FLAGS = ['--no-optional-locks', '-c', 'core.quotepath=off'];
const DIFF_FLAGS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--find-renames',
  '--relative',
];
const DEFAULT_BRANCH_CANDIDATES = [
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master',
];

export class SessionChangeError extends Error {
  constructor(
    readonly code: 'not-found' | 'unavailable' | 'invalid-request',
    message: string,
  ) {
    super(message);
    this.name = 'SessionChangeError';
  }
}

type Base = { revision: string; label: string };

const unavailable = (detail: string): SessionChangeSet => ({
  status: 'unavailable',
  base: null,
  files: [],
  additions: 0,
  deletions: 0,
  truncated: false,
  detail,
});

const shortRef = (ref: string) =>
  ref.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '');

const statusOf = (letter: string): SessionChangedFile['status'] => {
  if (letter.startsWith('A')) return 'added';
  if (letter.startsWith('D')) return 'removed';
  if (letter.startsWith('R') || letter.startsWith('C')) return 'renamed';
  return 'modified';
};

const parseNameStatus = (output: string) => {
  const tokens = output.split('\0');
  const entries: {
    path: string;
    previousPath: string | null;
    status: SessionChangedFile['status'];
  }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const letter = tokens[index];
    if (!letter) break;
    const status = statusOf(letter);
    if (status === 'renamed') {
      const previousPath = tokens[++index] ?? '';
      const path = tokens[++index] ?? '';
      if (path) entries.push({ path, previousPath, status });
      continue;
    }
    const path = tokens[++index] ?? '';
    if (path) entries.push({ path, previousPath: null, status });
  }
  return entries;
};

const countOf = (value: string) => (/^\d+$/.test(value) ? Number(value) : null);

const parseNumstat = (output: string) => {
  const tokens = output.split('\0');
  const counts = new Map<
    string,
    { additions: number | null; deletions: number | null }
  >();
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index];
    if (!record) break;
    const [added = '', removed = '', named = ''] = record.split('\t');
    let path = named;
    if (!path) {
      index += 2;
      path = tokens[index] ?? '';
    }
    if (path)
      counts.set(path, {
        additions: countOf(added),
        deletions: countOf(removed),
      });
  }
  return counts;
};

const lineCount = (text: string) =>
  text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;

const isText = (content: Buffer) => !content.includes(0);

export class SessionChangeReader {
  constructor(private readonly session: (id: string) => Session | undefined) {}

  private async root(sessionId: string): Promise<string> {
    const session = this.session(sessionId);
    if (!session)
      throw new SessionChangeError('not-found', 'Session not found.');
    if (!isAbsolute(session.directory))
      throw new SessionChangeError(
        'unavailable',
        'The session folder is unavailable.',
      );
    const directory = resolve(session.directory);
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory())
      throw new SessionChangeError(
        'unavailable',
        'The session folder is unavailable.',
      );
    return directory;
  }

  private async git(
    directory: string,
    args: string[],
    signal: AbortSignal,
    maxOutputBytes = MAX_LIST_OUTPUT_BYTES,
  ) {
    try {
      return await runGit({
        args: [...GLOBAL_FLAGS, ...args],
        cwd: directory,
        timeoutMs: GIT_TIMEOUT_MS,
        signal,
        untranslated: true,
        maxOutputBytes,
      });
    } catch (error) {
      if (error instanceof WorkspaceIsolationError)
        throw new SessionChangeError('unavailable', error.message);
      throw error;
    }
  }

  private async head(directory: string, signal: AbortSignal) {
    const result = await this.git(
      directory,
      ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
      signal,
    );
    const commit = result.stdout.trim();
    return result.code === 0 && COMMIT_PATTERN.test(commit) ? commit : null;
  }

  private async defaultBranch(directory: string, signal: AbortSignal) {
    const remoteHead = await this.git(
      directory,
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      signal,
    );
    const pointed = remoteHead.stdout.trim();
    const candidates = [
      ...(remoteHead.code === 0 && pointed.startsWith('refs/')
        ? [pointed]
        : []),
      ...DEFAULT_BRANCH_CANDIDATES,
    ];
    for (const ref of candidates) {
      const result = await this.git(
        directory,
        ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
        signal,
      );
      if (result.code === 0 && COMMIT_PATTERN.test(result.stdout.trim()))
        return ref;
    }
    return null;
  }

  private async branchBase(
    directory: string,
    head: string | null,
    signal: AbortSignal,
  ): Promise<Base | string> {
    if (!head) return 'The branch has no commits yet.';
    const ref = await this.defaultBranch(directory, signal);
    if (!ref) return 'No default branch was found to compare with.';
    const result = await this.git(
      directory,
      ['merge-base', 'HEAD', ref],
      signal,
    );
    const revision = result.stdout.trim();
    if (result.code !== 0 || !COMMIT_PATTERN.test(revision))
      return `This branch has no common history with ${shortRef(ref)}.`;
    return { revision, label: shortRef(ref) };
  }

  private async untracked(
    directory: string,
    signal: AbortSignal,
    path?: string,
  ) {
    const result = await this.git(
      directory,
      [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
        ...(path ? ['--', path] : []),
      ],
      signal,
    );
    if (result.code !== 0)
      throw new SessionChangeError(
        'unavailable',
        'Untracked files could not be listed.',
      );
    return {
      paths: result.stdout.split('\0').filter(Boolean),
      truncated: result.outputTruncated,
    };
  }

  private async readUntracked(directory: string, path: string, limit: number) {
    const absolute = join(directory, path);
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.size > limit) return null;
    return readFile(absolute).catch(() => null);
  }

  private async changeSet(
    directory: string,
    base: Base,
    untracked: { paths: string[]; truncated: boolean },
    signal: AbortSignal,
  ): Promise<SessionChangeSet> {
    const [names, numstat] = await Promise.all([
      this.git(
        directory,
        ['diff', ...DIFF_FLAGS, '--name-status', '-z', base.revision],
        signal,
      ),
      this.git(
        directory,
        ['diff', ...DIFF_FLAGS, '--numstat', '-z', base.revision],
        signal,
      ),
    ]);
    if (names.code !== 0 || numstat.code !== 0)
      return unavailable('Git could not compare the working tree.');
    const counts = parseNumstat(numstat.stdout);
    const tracked = parseNameStatus(names.stdout).map(
      (entry): SessionChangedFile => ({
        ...entry,
        additions: counts.get(entry.path)?.additions ?? null,
        deletions: counts.get(entry.path)?.deletions ?? null,
      }),
    );
    let budget = MAX_COUNTED_TOTAL_BYTES;
    const added: SessionChangedFile[] = [];
    for (const path of untracked.paths) {
      if (tracked.length + added.length >= sessionChangeLimits.files) break;
      const content =
        budget > 0
          ? await this.readUntracked(
              directory,
              path,
              Math.min(MAX_COUNTED_FILE_BYTES, budget),
            )
          : null;
      if (content) budget -= content.length;
      added.push({
        path,
        previousPath: null,
        status: 'untracked',
        additions:
          content && isText(content)
            ? lineCount(content.toString('utf8'))
            : null,
        deletions: content && isText(content) ? 0 : null,
      });
    }
    const all = [...tracked, ...added];
    const files = all.slice(0, sessionChangeLimits.files);
    return {
      status: 'available',
      base: base.label,
      files,
      additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
      deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      truncated:
        names.outputTruncated ||
        numstat.outputTruncated ||
        untracked.truncated ||
        tracked.length + untracked.paths.length > files.length,
      detail: null,
    };
  }

  async read(
    input: ReadSessionChangesInput,
    signal: AbortSignal,
  ): Promise<SessionChanges> {
    const directory = await this.root(input.sessionId);
    const readAt = new Date().toISOString();
    const inside = await this.git(
      directory,
      ['rev-parse', '--is-inside-work-tree'],
      signal,
    );
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      const detail = 'The session folder is not a Git repository.';
      return {
        sessionId: input.sessionId,
        readAt,
        uncommitted: unavailable(detail),
        branch: unavailable(detail),
      };
    }
    const head = await this.head(directory, signal);
    const untracked = await this.untracked(directory, signal);
    const uncommitted = await this.changeSet(
      directory,
      { revision: head ?? EMPTY_TREE, label: 'HEAD' },
      untracked,
      signal,
    );
    const base = await this.branchBase(directory, head, signal);
    return {
      sessionId: input.sessionId,
      readAt,
      uncommitted,
      branch:
        typeof base === 'string'
          ? unavailable(base)
          : await this.changeSet(directory, base, untracked, signal),
    };
  }

  private async revision(
    directory: string,
    scope: SessionChangeScope,
    signal: AbortSignal,
  ) {
    const head = await this.head(directory, signal);
    if (scope === 'uncommitted') return head ?? EMPTY_TREE;
    const base = await this.branchBase(directory, head, signal);
    if (typeof base === 'string')
      throw new SessionChangeError('unavailable', base);
    return base.revision;
  }

  private untrackedPatch(
    input: ReadSessionChangePatchInput,
    content: Buffer | null,
  ): SessionChangePatch {
    const result = {
      sessionId: input.sessionId,
      scope: input.scope,
      path: input.path,
    };
    if (!content)
      return {
        ...result,
        status: 'binary',
        patch: '',
        truncated: false,
        detail: 'This file is too large or not a regular file.',
      };
    if (!isText(content))
      return {
        ...result,
        status: 'binary',
        patch: '',
        truncated: false,
        detail: null,
      };
    const text = content.toString('utf8');
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    const header = [
      `diff --git a/${input.path} b/${input.path}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${input.path}`,
      `@@ -0,0 +1,${lines.length} @@`,
    ];
    const body = lines.map(line => `+${line}`);
    if (text && !text.endsWith('\n')) body.push('\\ No newline at end of file');
    const patch = [...header, ...body].join('\n') + '\n';
    const truncated = patch.length > sessionChangeLimits.patchBytes;
    return {
      ...result,
      status: lines.length ? 'text' : 'unchanged',
      patch: truncated ? patch.slice(0, sessionChangeLimits.patchBytes) : patch,
      truncated,
      detail: null,
    };
  }

  async patch(
    input: ReadSessionChangePatchInput,
    signal: AbortSignal,
  ): Promise<SessionChangePatch> {
    const directory = await this.root(input.sessionId);
    const untracked = await this.untracked(directory, signal, input.path);
    if (untracked.paths.includes(input.path))
      return this.untrackedPatch(
        input,
        await this.readUntracked(
          directory,
          input.path,
          sessionChangeLimits.patchBytes,
        ),
      );
    const revision = await this.revision(directory, input.scope, signal);
    const result = await this.git(
      directory,
      [
        'diff',
        ...DIFF_FLAGS,
        revision,
        '--',
        input.path,
        ...(input.previousPath ? [input.previousPath] : []),
      ],
      signal,
      sessionChangeLimits.patchBytes,
    );
    if (result.code !== 0)
      throw new SessionChangeError(
        'unavailable',
        'Git could not read this change.',
      );
    const patch = result.stdout;
    const status = !patch.trim()
      ? 'unchanged'
      : !patch.includes('\n@@ ') && /^Binary files /m.test(patch)
        ? 'binary'
        : 'text';
    return {
      sessionId: input.sessionId,
      scope: input.scope,
      path: input.path,
      status,
      patch: status === 'text' ? patch : '',
      truncated: result.outputTruncated,
      detail: null,
    };
  }
}
