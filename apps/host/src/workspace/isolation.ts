import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { Session } from '@nesvo/contracts';
import {
  OwnedProcessError,
  runOwnedProcess,
  type OwnedProcessResult,
} from '../process/owned-process';
import {
  copyWorktreeIncludes,
  readGitPointer,
  readWorktreeFile,
} from './worktree-files';

const GIT_QUERY_TIMEOUT_MS = 10_000;
const GIT_CHANGE_TIMEOUT_MS = 60_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const TASK_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FORWARDED_ENVIRONMENT = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
] as const;

export function worktreeSlug(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

export const SESSION_WORKTREE_BRANCH_PREFIX = 'nesvo/';

export type WorkspaceIsolationErrorCode =
  | 'invalid-project'
  | 'invalid-data-directory'
  | 'invalid-task'
  | 'invalid-branch'
  | 'not-a-repository'
  | 'not-repository-root'
  | 'no-base-commit'
  | 'data-inside-project'
  | 'nested-worktree'
  | 'branch-exists'
  | 'worktree-exists'
  | 'not-a-task-worktree'
  | 'dirty-worktree'
  | 'patch-too-large'
  | 'git-unavailable'
  | 'git-failed'
  | 'timed-out'
  | 'cancelled';

export class WorkspaceIsolationError extends Error {
  readonly code: WorkspaceIsolationErrorCode;

  constructor(code: WorkspaceIsolationErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceIsolationError';
    this.code = code;
  }
}

export type TaskWorktree = {
  worktree: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  prunable: boolean;
};

export type CreateTaskWorktreeParams = {
  projectDirectory: string;
  dataDirectory: string;
  slug: string;
  runId: string;
  signal: AbortSignal;
};

export type RemoveTaskWorktreeParams = {
  projectDirectory: string;
  dataDirectory: string;
  worktree: string;
  force?: boolean;
  signal: AbortSignal;
};

export type ListTaskWorktreesParams = {
  projectDirectory: string;
  dataDirectory: string;
  signal: AbortSignal;
};

export type GitCall = {
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  untranslated?: boolean;
  stdin?: Buffer;
  maxOutputBytes?: number;
  captureStdoutBytes?: boolean;
};

function fail(code: WorkspaceIsolationErrorCode, message: string): never {
  throw new WorkspaceIsolationError(code, message);
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function realDirectory(path: string): string | null {
  try {
    if (!isAbsolute(path) || !statSync(path).isDirectory()) return null;
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function realPathOf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  for (const name of FORWARDED_ENVIRONMENT) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function gitExecutable(): { command: string; prefix: string[] } {
  const override = process.env.NESVO_GIT_EXECUTABLE;
  if (override) {
    if (!isAbsolute(override))
      throw new Error('NESVO_GIT_EXECUTABLE must be an absolute path.');
    return /\.(?:mjs|cjs|js)$/i.test(override)
      ? { command: process.execPath, prefix: [override] }
      : { command: override, prefix: [] };
  }
  const name = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const entry = directory.replace(/^"|"$/g, '');
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    try {
      accessSync(
        candidate,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      if (statSync(candidate).isFile())
        return { command: candidate, prefix: [] };
    } catch {
      continue;
    }
  }
  return fail('git-unavailable', 'Git was not found on PATH.');
}

export async function runGit({
  args,
  cwd,
  timeoutMs,
  signal,
  untranslated = false,
  stdin,
  maxOutputBytes = MAX_GIT_OUTPUT_BYTES,
  captureStdoutBytes,
}: GitCall): Promise<OwnedProcessResult> {
  const executable = gitExecutable();
  const environment = gitEnvironment();
  if (executable.prefix.length > 0) environment.ELECTRON_RUN_AS_NODE = '1';
  if (untranslated) {
    environment.LC_ALL = 'C';
    delete environment.LANGUAGE;
  }
  let result: OwnedProcessResult;
  try {
    result = await runOwnedProcess({
      command: executable.command,
      args: [...executable.prefix, ...args],
      cwd,
      env: environment,
      timeoutMs,
      maxOutputBytes,
      stdin,
      captureStdoutBytes,
      signal,
    });
  } catch (error) {
    if (!(error instanceof OwnedProcessError)) throw error;
    if (error.code === 'cancelled')
      return fail('cancelled', 'The Git operation was cancelled.');
    if (
      error.code === 'spawn-failed' &&
      error.systemCode === 'ENOENT' &&
      !pathExists(executable.command)
    )
      return fail('git-unavailable', 'Git could not be started.');
    return fail('git-failed', 'The Git process did not finish cleanly.');
  }
  if (result.timedOut)
    fail('timed-out', 'The Git operation did not finish in time.');
  return result;
}

export async function readWorkflowDiff(
  directory: string,
  base: string | undefined,
  signal: AbortSignal,
): Promise<{ patches: string[]; complete: boolean }> {
  const maxBytes = 2 * 1024 * 1024;
  const timeoutMs = 10_000;
  const boundedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const options = { cwd: directory, signal: boundedSignal, timeoutMs };
  const flags = [
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--no-renames',
    '--unified=0',
  ];
  const reference = base && /^[a-f0-9]{40,64}$/.test(base) ? base : 'HEAD';
  const patches: string[] = [];
  let remaining = maxBytes;
  try {
    const tracked = await runGit({
      ...options,
      args: [
        '-c',
        'core.quotePath=false',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'diff.autoRefreshIndex=false',
        'diff',
        ...flags,
        '--relative',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        reference,
        '--',
        '.',
      ],
      maxOutputBytes: remaining,
    });
    if (tracked.code !== 0 || tracked.outputTruncated)
      return { patches, complete: false };
    patches.push(tracked.stdout);
    remaining -= Buffer.byteLength(tracked.stdout);
    const untracked = await runGit({
      ...options,
      args: ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'],
      maxOutputBytes: 128 * 1024,
    });
    if (untracked.code !== 0 || untracked.outputTruncated)
      return { patches, complete: false };
    const files = untracked.stdout.split('\0').filter(Boolean);
    for (const name of files.slice(0, 80)) {
      if (remaining <= 0 || boundedSignal.aborted)
        return { patches, complete: false };
      const path = resolve(directory, name);
      if (
        !isInside(directory, path) ||
        realpathSync.native(path) !== path ||
        !lstatSync(path).isFile()
      )
        return { patches, complete: false };
      const patch = await runGit({
        ...options,
        args: [
          '-c',
          'core.quotePath=false',
          'diff',
          '--no-index',
          ...flags,
          '--',
          '/dev/null',
          './' + name,
        ],
        maxOutputBytes: remaining,
      });
      if ((patch.code !== 0 && patch.code !== 1) || patch.outputTruncated)
        return { patches, complete: false };
      patches.push(patch.stdout);
      remaining -= Buffer.byteLength(patch.stdout);
    }
    return { patches, complete: files.length <= 80 };
  } catch {
    return { patches, complete: false };
  }
}

function gitMessage(result: OwnedProcessResult): string {
  const detail = result.stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 300);
  return detail ? `Git failed: ${detail}` : 'Git failed.';
}

export async function repositoryRoot(
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runGit({
    args: ['rev-parse', '--show-toplevel'],
    cwd: directory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  const root = result.stdout.trim();
  if (result.code !== 0 || !root)
    fail(
      'not-a-repository',
      'The project directory is not inside a Git work tree.',
    );
  return realPathOf(resolve(root));
}

export async function currentGitBranch(directory: string, signal: AbortSignal) {
  const result = await runGit({
    args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    cwd: directory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0 || !result.stdout.trim())
    fail(
      'invalid-branch',
      'Check out a named branch before creating a writable worker.',
    );
  return result.stdout.trim();
}

async function headCommit(
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runGit({
    args: ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    cwd: directory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  const commit = result.stdout.trim();
  if (result.code !== 0 || !COMMIT_PATTERN.test(commit))
    fail('no-base-commit', 'The project has no commit to start a task from.');
  return commit;
}

async function branchExists(
  directory: string,
  branch: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runGit({
    args: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    cwd: directory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return fail('git-failed', gitMessage(result));
}

function worktreesRoot(
  dataDirectory: string,
  create: boolean,
  rootName = 'worktrees',
): string | null {
  const data = realDirectory(dataDirectory);
  if (!data)
    fail('invalid-data-directory', 'The data directory does not exist.');
  const root = join(data, rootName);
  if (create) mkdirSync(root, { recursive: true });
  const resolved = realDirectory(root);
  if (resolved && resolved !== root)
    fail(
      'invalid-data-directory',
      'The worktree directory must be inside the data directory.',
    );
  return resolved;
}

function parseWorktreeList(output: string): TaskWorktree[] {
  const nul = output.includes('\0');
  return output
    .split(nul ? '\0\0' : /\r?\n\r?\n/)
    .map(block => block.split(nul ? '\0' : /\r?\n/).filter(Boolean))
    .filter(lines => lines[0]?.startsWith('worktree '))
    .map(lines => {
      const value = (key: string) =>
        lines
          .find(line => line === key || line.startsWith(`${key} `))
          ?.slice(key.length + 1);
      const ref = value('branch');
      return {
        worktree: realPathOf(resolve(lines[0]!.slice('worktree '.length))),
        branch: ref?.startsWith('refs/heads/')
          ? ref.slice('refs/heads/'.length)
          : null,
        head: value('HEAD') ?? null,
        locked: value('locked') !== undefined,
        prunable: value('prunable') !== undefined,
      };
    });
}

export async function registeredWorktrees(
  projectDirectory: string,
  signal: AbortSignal,
  gitDirectory?: string,
): Promise<TaskWorktree[]> {
  const result = await runGit({
    args: [
      ...(gitDirectory ? [`--git-dir=${gitDirectory}`] : []),
      'worktree',
      'list',
      '--porcelain',
      ...(gitDirectory ? ['-z'] : []),
    ],
    cwd: projectDirectory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0 || result.outputTruncated)
    fail('git-failed', gitMessage(result));
  return parseWorktreeList(result.stdout);
}

function projectPath(projectDirectory: string): string {
  const project = realDirectory(projectDirectory);
  if (!project)
    fail(
      'invalid-project',
      'The project directory does not exist. Enter its absolute path.',
    );
  return project;
}

export async function isRepositoryRoot(
  directory: string,
  signal: AbortSignal,
): Promise<boolean> {
  const project = projectPath(directory);
  try {
    return (await repositoryRoot(project, signal)) === project;
  } catch (error) {
    if (
      error instanceof WorkspaceIsolationError &&
      (error.code === 'not-a-repository' || error.code === 'git-unavailable')
    )
      return false;
    throw error;
  }
}

export async function isGitHubRepositoryRoot(
  directory: string,
  repository: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!(await isRepositoryRoot(directory, signal))) return false;
  return (await readGitHubFetchRemotes(directory, signal)).some(
    name => name.toLowerCase() === repository.toLowerCase(),
  );
}

export async function readGitHubFetchRemotes(
  directory: string,
  signal: AbortSignal,
): Promise<string[]> {
  return (await readGitHubFetchRemoteEntries(directory, signal)).map(
    remote => remote.repository,
  );
}

export async function readGitHubFetchRemoteEntries(
  directory: string,
  signal: AbortSignal,
): Promise<{ name: string; repository: string }[]> {
  const remotes = await runGit({
    args: ['remote', '-v'],
    cwd: directory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
    untranslated: true,
  });
  if (remotes.code !== 0 || remotes.outputTruncated) return [];
  const fetchRemote =
    /^(\S+)\t(?:(?:https?|ssh|git):\/\/(?:[^/\s@]+@)?github\.com(?::\d+)?\/|(?:[^/\s@]+@)?github\.com:)([a-z0-9-]+\/[a-z0-9._-]+) \(fetch\)$/i;
  return remotes.stdout.split(/\r?\n/).flatMap(line => {
    const match = fetchRemote.exec(line);
    return match
      ? [{ name: match[1]!, repository: match[2]!.replace(/\.git$/i, '') }]
      : [];
  });
}

export async function readHeadCommit(
  directory: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runGit({
    args: ['rev-parse', 'HEAD'],
    cwd: directory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
    untranslated: true,
  });
  const commit = result.stdout.trim();
  if (result.code !== 0 || !COMMIT_PATTERN.test(commit))
    fail('git-failed', 'Git could not read the checked out commit.');
  return commit;
}

export function createTaskWorktree(input: CreateTaskWorktreeParams) {
  return createWorktree(input, 'worktrees').then(
    ({ worktree, branch, base }) => ({
      worktree,
      branch,
      base,
    }),
  );
}

const SESSION_ROOT = 'session-worktrees';
const RECORDS_ROOT = 'session-worktree-records';
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

type SessionOptions = {
  branch?: string;
  baseCommit?: string;
  carryChanges?: boolean;
  fork?: boolean;
  sourceWorktree?: Pick<
    SessionWorktreeLocation,
    'projectDirectory' | 'worktree'
  >;
};

type SessionCheckout = {
  id: string;
  worktree: string;
  projectDirectory: string;
  gitDirectory: string;
  branch: string;
};

export async function repositoryGitDirectory(
  directory: string,
  signal: AbortSignal,
) {
  const result = await runGit({
    args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    cwd: directory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  const gitDirectory = realDirectory(result.stdout.trim());
  if (result.code !== 0 || result.outputTruncated || !gitDirectory)
    fail('git-failed', 'The Git repository could not be identified.');
  return gitDirectory;
}

export function sessionCheckout(
  dataDirectory: string,
  id: string,
): SessionCheckout | undefined {
  if (!RUN_ID_PATTERN.test(id)) return;
  const records = worktreesRoot(dataDirectory, false, RECORDS_ROOT);
  const root = worktreesRoot(dataDirectory, false, SESSION_ROOT);
  if (!records || !root) return;
  try {
    const record: Partial<SessionCheckout> = JSON.parse(
      readWorktreeFile(records, `${id}.json`, 64 * 1024).toString('utf8'),
    );
    if (
      record.id === id &&
      typeof record.worktree === 'string' &&
      isInside(root, record.worktree) &&
      resolve(record.worktree, '..') === root &&
      relative(root, record.worktree).startsWith(`${id.slice(0, 8)}-`) &&
      typeof record.gitDirectory === 'string' &&
      isAbsolute(record.gitDirectory) &&
      typeof record.projectDirectory === 'string' &&
      isAbsolute(record.projectDirectory) &&
      typeof record.branch === 'string'
    )
      return {
        id,
        worktree: record.worktree,
        gitDirectory: record.gitDirectory,
        projectDirectory: record.projectDirectory,
        branch: record.branch,
      };
  } catch {
    return;
  }
}

function listSessionCheckouts(dataDirectory: string): SessionCheckout[] {
  const root = worktreesRoot(dataDirectory, false, RECORDS_ROOT);
  if (!root) return [];
  return readdirSync(root).flatMap(file => {
    if (!file.endsWith('.json')) return [];
    const record = sessionCheckout(dataDirectory, file.slice(0, -5));
    return record && realDirectory(record.worktree) === record.worktree
      ? [record]
      : [];
  });
}

export function orphanedSessionCheckouts(
  dataDirectory: string,
  sessions: Session[],
) {
  const root = worktreesRoot(dataDirectory, false, SESSION_ROOT);
  if (!root) return [];
  const byId = new Map(sessions.map(session => [session.id, session]));
  const live = sessions.filter(
    session =>
      ![session, byId.get(session.parentId ?? '')].some(
        owner => owner?.worktree && owner.worktree.state !== 'active',
      ),
  );
  const checkouts = new Map<
    string,
    Omit<SessionCheckout, 'gitDirectory'> & { gitDirectory?: string }
  >(listSessionCheckouts(dataDirectory).map(record => [record.id, record]));
  for (const { id, directory, worktree } of sessions) {
    if (
      worktree?.state !== 'kept' ||
      checkouts.has(id) ||
      resolve(directory, '..') !== root ||
      realDirectory(directory) !== directory
    )
      continue;
    checkouts.set(id, {
      id,
      worktree: directory,
      branch: worktree.branch,
      projectDirectory: worktree.projectDirectory,
    });
  }
  return [...checkouts.values()]
    .filter(
      record =>
        !live.some(session => isInside(record.worktree, session.directory)),
    )
    .map(record => ({ ...record, session: byId.get(record.id) }));
}

async function includeWorktreeFiles(
  source: string,
  target: string,
  recordPath: string,
  signal: AbortSignal,
) {
  let patterns: Buffer;
  try {
    patterns = readWorktreeFile(source, '.worktreeinclude', 64 * 1024);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? undefined
      : { copied: 0, skipped: 0, incomplete: true };
  }
  writeFileSync(recordPath, patterns, { flag: 'wx', mode: 0o600 });
  try {
    const result = await runGit({
      args: [
        'ls-files',
        '--others',
        '--ignored',
        '-z',
        `--exclude-from=${recordPath}`,
      ],
      cwd: source,
      timeoutMs: GIT_QUERY_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      signal,
    });
    if (result.code !== 0) return { copied: 0, skipped: 0, incomplete: true };
    const paths = result.stdout.split('\0').slice(0, -1);
    const validPaths = paths.filter(path => !path.includes('\uFFFD'));
    const { copied } = copyWorktreeIncludes(source, target, validPaths);
    return {
      copied,
      skipped: paths.length - copied,
      incomplete: result.outputTruncated,
    };
  } catch (error) {
    if (error instanceof WorkspaceIsolationError && error.code === 'timed-out')
      return { copied: 0, skipped: 0, incomplete: true };
    throw error;
  } finally {
    unlinkSync(recordPath);
  }
}

export function createSessionWorktree(
  input: CreateTaskWorktreeParams & SessionOptions,
) {
  return createWorktree(input, SESSION_ROOT);
}

async function createWorktree(
  {
    projectDirectory,
    dataDirectory,
    slug,
    runId,
    signal,
    branch: requestedBranch,
    baseCommit,
    fork,
    carryChanges,
    sourceWorktree,
  }: CreateTaskWorktreeParams & SessionOptions,
  rootName: string,
) {
  if (signal.aborted) fail('cancelled', 'The Git operation was cancelled.');
  if (!TASK_SLUG_PATTERN.test(slug))
    fail('invalid-task', 'The task name must be a short lowercase slug.');
  if (!RUN_ID_PATTERN.test(runId))
    fail('invalid-task', 'The run identifier is invalid.');
  const project = projectPath(projectDirectory);
  const roots = ['worktrees', SESSION_ROOT].map(name =>
    worktreesRoot(dataDirectory, false, name),
  );
  if (
    roots.some(
      (root, index) =>
        root && isInside(root, project) && !(fork && index === 1),
    )
  )
    fail(
      'nested-worktree',
      'The project directory is a task worktree. Start the task from the original project.',
    );
  let repository: string;
  let originalProject: string;
  let gitDirectory: string | undefined;
  if (roots[1] && isInside(roots[1], project)) {
    const source =
      listSessionCheckouts(dataDirectory).find(record =>
        isInside(record.worktree, project),
      ) ?? sourceWorktree;
    const registration =
      source &&
      (await registeredSessionWorktree({ ...source, dataDirectory, signal }));
    if (
      !source ||
      !registration ||
      !isInside(registration.target.worktree, project)
    )
      fail('not-a-task-worktree', 'The source worktree could not be verified.');
    repository = registration.target.worktree;
    originalProject = source.projectDirectory;
    gitDirectory = registration.gitDirectory;
  } else {
    repository = await repositoryRoot(project, signal);
    originalProject = repository;
  }
  if (rootName === 'worktrees' && repository !== project)
    fail(
      'not-repository-root',
      'Choose the top-level directory of the Git repository.',
    );
  if (isInside(repository, realPathOf(dataDirectory)))
    fail(
      'data-inside-project',
      'The data directory is inside the project. Task worktrees would be nested in it.',
    );
  if (baseCommit && !COMMIT_PATTERN.test(baseCommit))
    fail('no-base-commit', 'The requested base commit is invalid.');
  const base = baseCommit ?? (await headCommit(repository, signal));
  const shortId = runId.slice(0, 8).toLowerCase();
  const branch =
    requestedBranch ?? `${SESSION_WORKTREE_BRANCH_PREFIX}${slug}-${shortId}`;
  if (requestedBranch) {
    const checked = await runGit({
      args: ['check-ref-format', '--branch', branch],
      cwd: repository,
      timeoutMs: GIT_QUERY_TIMEOUT_MS,
      signal,
    });
    if (checked.code !== 0 || checked.stdout.trim() !== branch)
      fail('invalid-branch', 'Use a valid Git branch name.');
  }
  const worktreeRoot = worktreesRoot(dataDirectory, true, rootName);
  if (!worktreeRoot)
    fail(
      'invalid-data-directory',
      'The worktree directory could not be created.',
    );
  const worktree = join(worktreeRoot, `${shortId}-${slug}`);
  if (pathExists(worktree))
    fail('worktree-exists', 'A worktree for this task already exists.');
  if (await branchExists(repository, branch, signal))
    fail('branch-exists', `The branch ${branch} already exists.`);
  let patch: Buffer | undefined;
  if (carryChanges) {
    const diff = await runGit({
      args: [
        'diff',
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        base,
        '--',
      ],
      cwd: repository,
      timeoutMs: GIT_QUERY_TIMEOUT_MS,
      maxOutputBytes: MAX_PATCH_BYTES,
      captureStdoutBytes: true,
      signal,
    });
    if (diff.code !== 0) fail('git-failed', gitMessage(diff));
    if (diff.outputTruncated)
      fail('patch-too-large', 'The source patch exceeds 8 MiB.');
    patch = diff.stdoutBytes;
  }
  let records: string | undefined;
  if (rootName === SESSION_ROOT) {
    records = worktreesRoot(dataDirectory, true, RECORDS_ROOT)!;
    gitDirectory ??= await repositoryGitDirectory(repository, signal);
    const record: SessionCheckout = {
      id: runId,
      worktree,
      projectDirectory: originalProject,
      gitDirectory,
      branch,
    };
    writeFileSync(join(records, `${runId}.json`), JSON.stringify(record), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  let result: OwnedProcessResult;
  try {
    result = await runGit({
      args: ['worktree', 'add', worktree, '-b', branch, base],
      cwd: repository,
      timeoutMs: GIT_CHANGE_TIMEOUT_MS,
      signal,
    });
  } catch (error) {
    if (
      error instanceof WorkspaceIsolationError &&
      (error.code === 'timed-out' || error.code === 'cancelled')
    )
      fail(
        error.code,
        `${error.message} The worktree ${worktree} and branch ${branch} may be partly created; remove them explicitly.`,
      );
    throw error;
  }
  if (result.code !== 0) fail('git-failed', gitMessage(result));
  if (records && realDirectory(worktree) !== worktree)
    fail(
      'not-a-task-worktree',
      'The new worktree path changed during creation.',
    );
  if (patch?.length && gitDirectory) {
    const admin = checkoutGitDirectory(worktree, gitDirectory);
    const applied = await runGit({
      args: [
        `--git-dir=${admin}`,
        `--work-tree=${worktree}`,
        'apply',
        '--whitespace=nowarn',
        '-',
      ],
      cwd: worktree,
      timeoutMs: GIT_QUERY_TIMEOUT_MS,
      stdin: patch,
      signal,
    });
    if (applied.code !== 0)
      fail(
        'git-failed',
        'The source patch could not be applied. Find the retained checkout in Data settings.',
      );
  }
  const includes = records
    ? await includeWorktreeFiles(
        repository,
        worktree,
        join(records, `${runId}.include`),
        signal,
      )
    : undefined;
  return {
    worktree: realPathOf(worktree),
    branch,
    base,
    projectDirectory: originalProject,
    includes,
  };
}

type SessionWorktreeLocation = ListTaskWorktreesParams & {
  worktree: string;
  gitDirectory?: string;
  binding?: NonNullable<Session['worktree']>['binding'];
};

async function registeredSessionWorktree({
  dataDirectory,
  projectDirectory,
  worktree,
  signal,
  gitDirectory: recordedGitDirectory,
  binding,
}: SessionWorktreeLocation) {
  const root = worktreesRoot(dataDirectory, false, SESSION_ROOT);
  if (
    !isAbsolute(worktree) ||
    (binding
      ? binding.checkout !== worktree ||
        !isInside(binding.root, worktree) ||
        binding.root === worktree
      : root && resolve(worktree, '..') !== root) ||
    realPathOf(worktree) !== worktree
  )
    fail(
      'not-a-task-worktree',
      'This path is outside the managed session worktrees.',
    );
  if ((!root && !binding) || !pathExists(worktree)) return;
  const gitDirectory =
    binding?.gitDirectory ??
    recordedGitDirectory ??
    (await repositoryGitDirectory(projectPath(projectDirectory), signal));
  if (realDirectory(gitDirectory) !== gitDirectory)
    fail('not-a-task-worktree', 'The original Git repository is unavailable.');
  const cwd = projectPath(dataDirectory);
  const target = (await registeredWorktrees(cwd, signal, gitDirectory)).find(
    entry => entry.worktree === worktree,
  );
  if (!target && pathExists(worktree))
    fail(
      'not-a-task-worktree',
      'This path is no longer a registered session worktree.',
    );
  if (!target) return;
  if (binding && (target.prunable || target.branch !== binding.branch))
    fail(
      'not-a-task-worktree',
      'The bound worktree branch or registration has changed.',
    );
  const admin = checkoutGitDirectory(worktree, gitDirectory);
  return { target, gitDirectory, admin, cwd };
}

function checkoutGitDirectory(worktree: string, gitDirectory: string) {
  try {
    const pointer = readGitPointer(worktree);
    if (!pointer.startsWith('gitdir: ')) throw new Error();
    const admin = resolve(worktree, pointer.slice('gitdir: '.length));
    if (
      resolve(admin, '..') !== join(gitDirectory, 'worktrees') ||
      realDirectory(admin) !== admin ||
      realDirectory(
        resolve(
          admin,
          readWorktreeFile(admin, 'commondir', 4096).toString('utf8').trimEnd(),
        ),
      ) !== gitDirectory ||
      resolve(
        admin,
        readWorktreeFile(admin, 'gitdir', 4096).toString('utf8').trimEnd(),
      ) !== join(worktree, '.git')
    )
      throw new Error();
    return admin;
  } catch {
    return fail(
      'not-a-task-worktree',
      'The worktree Git pointer does not match its registered repository.',
    );
  }
}

export async function readSessionWorktreeStatus(
  input: SessionWorktreeLocation,
) {
  const registration = await registeredSessionWorktree(input);
  return {
    dirty:
      registration && !registration.target.prunable
        ? await worktreeDirty(registration, input.signal)
        : false,
  };
}

export async function confirmSessionWorktree(input: SessionWorktreeLocation) {
  const registration = await registeredSessionWorktree(input);
  if (!registration)
    fail('not-a-task-worktree', 'This worktree is no longer available.');
  return registration.gitDirectory;
}

async function worktreeDirty(
  {
    target,
    admin,
    cwd,
  }: NonNullable<Awaited<ReturnType<typeof registeredSessionWorktree>>>,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runGit({
    args: [
      `--git-dir=${admin}`,
      `--work-tree=${target.worktree}`,
      '-c',
      'core.fsmonitor=false',
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--ignored=matching',
      '--ignore-submodules=none',
    ],
    cwd,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0) fail('git-failed', gitMessage(result));
  return result.stdout.length > 0 || result.outputTruncated;
}

export async function removeSessionWorktree(
  input: SessionWorktreeLocation & {
    force?: boolean;
    allowsIgnoredFiles?: boolean;
    removeBound?: () => Promise<void>;
  },
) {
  const registration = await registeredSessionWorktree(input);
  if (!registration) {
    if (input.binding)
      fail(
        'not-a-task-worktree',
        'The bound checkout is missing. Review the previous removal receipt.',
      );
    return;
  }
  const { target, gitDirectory, cwd } = registration;
  if (
    !input.force &&
    !input.allowsIgnoredFiles &&
    !target.prunable &&
    (await worktreeDirty(registration, input.signal))
  )
    fail(
      'dirty-worktree',
      'The worktree has uncommitted changes. Commit them or explicitly confirm removal.',
    );
  if (input.binding) {
    if (!input.removeBound)
      fail(
        'not-a-task-worktree',
        'A bound checkout must be removed by its pinned provider.',
      );
    await input.removeBound();
    if (input.binding.providerKind === 'external') return;
  }
  await removeWorktree(
    { ...input, projectDirectory: cwd },
    target,
    gitDirectory,
  );
}

export function includeBoundWorktreeFiles(
  dataDirectory: string,
  sessionId: string,
  source: string,
  target: string,
  signal: AbortSignal,
) {
  if (!RUN_ID_PATTERN.test(sessionId))
    fail('invalid-task', 'The session identifier is invalid.');
  const records = worktreesRoot(dataDirectory, true, RECORDS_ROOT)!;
  return includeWorktreeFiles(
    source,
    target,
    join(records, `${sessionId}.include`),
    signal,
  );
}

export async function listTaskWorktrees({
  projectDirectory,
  dataDirectory,
  signal,
}: ListTaskWorktreesParams): Promise<TaskWorktree[]> {
  if (signal.aborted) fail('cancelled', 'The Git operation was cancelled.');
  const project = projectPath(projectDirectory);
  const root = worktreesRoot(dataDirectory, false);
  if (!root) return [];
  return (await registeredWorktrees(project, signal)).filter(
    entry => entry.worktree !== root && isInside(root, entry.worktree),
  );
}

export async function removeTaskWorktree({
  projectDirectory,
  dataDirectory,
  worktree,
  force = false,
  signal,
}: RemoveTaskWorktreeParams): Promise<TaskWorktree> {
  if (signal.aborted) fail('cancelled', 'The Git operation was cancelled.');
  if (!isAbsolute(worktree))
    fail('not-a-task-worktree', 'The worktree path must be absolute.');
  const target = (
    await listTaskWorktrees({ projectDirectory, dataDirectory, signal })
  ).find(entry => entry.worktree === realPathOf(resolve(worktree)));
  if (!target)
    fail(
      'not-a-task-worktree',
      'This directory is not a task worktree of the project.',
    );
  return removeWorktree(
    { projectDirectory, dataDirectory, worktree, force, signal },
    target,
  );
}

async function removeWorktree(
  { projectDirectory, force, signal }: RemoveTaskWorktreeParams,
  target: TaskWorktree,
  gitDirectory?: string,
): Promise<TaskWorktree> {
  const result = await runGit({
    args: [
      ...(gitDirectory ? [`--git-dir=${gitDirectory}`] : []),
      'worktree',
      'remove',
      ...(force ? ['--force'] : []),
      target.worktree,
    ],
    cwd: projectPath(projectDirectory),
    timeoutMs: GIT_CHANGE_TIMEOUT_MS,
    signal,
    untranslated: true,
  });
  if (
    result.code !== 0 &&
    !force &&
    /contains modified or untracked files/.test(result.stderr)
  )
    fail(
      'dirty-worktree',
      'The worktree has uncommitted changes. Commit them or remove it with force.',
    );
  if (result.code !== 0) fail('git-failed', gitMessage(result));
  return target;
}

const MERGED_CHANGE_LIMIT = 50;
const MERGED_COMMIT_LIMIT = 20;
const MERGED_SUBJECT_LENGTH = 200;

export type MergedWorktreeInspection = {
  registered: boolean;
  changes: string[];
  changesTruncated: boolean;
  localFiles: number;
  unpushed: { sha: string; subject: string }[];
  unpushedTruncated: boolean;
  branchExists: boolean;
};

type MergedWorktreeParams = SessionWorktreeLocation & {
  branch: string;
  mergedHead: string | null;
};

async function gitSucceeds(
  gitDirectory: string,
  args: string[],
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runGit({
    args: [`--git-dir=${gitDirectory}`, ...args],
    cwd: dirname(gitDirectory),
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  return result.code === 0;
}

async function worktreeChanges(
  registration: NonNullable<
    Awaited<ReturnType<typeof registeredSessionWorktree>>
  >,
  signal: AbortSignal,
) {
  const result = await runGit({
    args: [
      `--git-dir=${registration.admin}`,
      `--work-tree=${registration.target.worktree}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.quotePath=false',
      '--no-optional-locks',
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--ignored=matching',
      '--ignore-submodules=none',
    ],
    cwd: registration.cwd,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0) fail('git-failed', gitMessage(result));
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const changed = lines.filter(line => !line.startsWith('!! '));
  return {
    changes: changed.slice(0, MERGED_CHANGE_LIMIT).map(line => line.slice(3)),
    changesTruncated:
      changed.length > MERGED_CHANGE_LIMIT || result.outputTruncated,
    localFiles: lines.length - changed.length,
  };
}

async function unpushedCommits(
  gitDirectory: string,
  tips: string[],
  mergedHead: string | null,
  signal: AbortSignal,
) {
  if (tips.length === 0) return { unpushed: [], unpushedTruncated: false };
  const known =
    mergedHead &&
    (await gitSucceeds(
      gitDirectory,
      ['cat-file', '-e', `${mergedHead}^{commit}`],
      signal,
    ));
  const result = await runGit({
    args: [
      `--git-dir=${gitDirectory}`,
      'log',
      `--max-count=${MERGED_COMMIT_LIMIT + 1}`,
      '--format=%H%x09%s',
      ...tips,
      '--not',
      '--remotes',
      ...(known ? [mergedHead] : []),
      '--',
    ],
    cwd: dirname(gitDirectory),
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0) fail('git-failed', gitMessage(result));
  const commits = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const [sha = '', ...subject] = line.split('\t');
      return {
        sha,
        subject: subject.join('\t').slice(0, MERGED_SUBJECT_LENGTH),
      };
    });
  return {
    unpushed: commits.slice(0, MERGED_COMMIT_LIMIT),
    unpushedTruncated: commits.length > MERGED_COMMIT_LIMIT,
  };
}

export async function inspectMergedSessionWorktree(
  input: MergedWorktreeParams,
): Promise<MergedWorktreeInspection> {
  const registration = await registeredSessionWorktree(input);
  const gitDirectory =
    registration?.gitDirectory ??
    input.gitDirectory ??
    (await repositoryGitDirectory(
      projectPath(input.projectDirectory),
      input.signal,
    ));
  const branchExists = await gitSucceeds(
    gitDirectory,
    ['show-ref', '--verify', '--quiet', `refs/heads/${input.branch}`],
    input.signal,
  );
  const live = registration && !registration.target.prunable;
  const status = live
    ? await worktreeChanges(registration, input.signal)
    : { changes: [], changesTruncated: false, localFiles: 0 };
  const commits = await unpushedCommits(
    live ? registration.admin : gitDirectory,
    [...(live ? ['HEAD'] : []), ...(branchExists ? [input.branch] : [])],
    input.mergedHead,
    input.signal,
  );
  return {
    registered: !!live,
    ...status,
    ...commits,
    branchExists,
  };
}

export async function deleteMergedSessionBranch(input: {
  projectDirectory: string;
  gitDirectory?: string;
  branch: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const gitDirectory =
    input.gitDirectory ??
    (await repositoryGitDirectory(
      projectPath(input.projectDirectory),
      input.signal,
    ));
  const result = await runGit({
    args: [`--git-dir=${gitDirectory}`, 'branch', '-D', input.branch],
    cwd: dirname(gitDirectory),
    timeoutMs: GIT_CHANGE_TIMEOUT_MS,
    signal: input.signal,
  });
  return result.code === 0;
}
