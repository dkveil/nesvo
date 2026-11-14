import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PipelineIsolation } from '@nesvo/contracts';
import {
  OwnedProcessError,
  runOwnedProcess,
  type OwnedProcessResult,
} from '../process/owned-process';

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

export type WorkspaceIsolationErrorCode =
  | 'invalid-project'
  | 'invalid-data-directory'
  | 'invalid-task'
  | 'not-a-repository'
  | 'not-repository-root'
  | 'no-base-commit'
  | 'data-inside-project'
  | 'nested-worktree'
  | 'branch-exists'
  | 'worktree-exists'
  | 'not-a-task-worktree'
  | 'dirty-worktree'
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

type GitCall = {
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  untranslated?: boolean;
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

async function runGit({
  args,
  cwd,
  timeoutMs,
  signal,
  untranslated = false,
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
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
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

function gitMessage(result: OwnedProcessResult): string {
  const detail = result.stderr.trim().split(/\r?\n/).at(-1)?.slice(0, 300);
  return detail ? `Git failed: ${detail}` : 'Git failed.';
}

async function repositoryRoot(
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

function worktreesRoot(dataDirectory: string, create: boolean): string | null {
  const data = realDirectory(dataDirectory);
  if (!data)
    fail('invalid-data-directory', 'The data directory does not exist.');
  const root = join(data, 'worktrees');
  if (create) mkdirSync(root, { recursive: true });
  return realDirectory(root);
}

function parseWorktreeList(output: string): TaskWorktree[] {
  return output
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).filter(Boolean))
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

async function registeredWorktrees(
  projectDirectory: string,
  signal: AbortSignal,
): Promise<TaskWorktree[]> {
  const result = await runGit({
    args: ['worktree', 'list', '--porcelain'],
    cwd: projectDirectory,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    signal,
  });
  if (result.code !== 0) fail('git-failed', gitMessage(result));
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

export async function createTaskWorktree({
  projectDirectory,
  dataDirectory,
  slug,
  runId,
  signal,
}: CreateTaskWorktreeParams): Promise<PipelineIsolation> {
  if (signal.aborted) fail('cancelled', 'The Git operation was cancelled.');
  if (!TASK_SLUG_PATTERN.test(slug))
    fail('invalid-task', 'The task name must be a short lowercase slug.');
  if (!RUN_ID_PATTERN.test(runId))
    fail('invalid-task', 'The run identifier is invalid.');
  const project = projectPath(projectDirectory);
  const root = worktreesRoot(dataDirectory, false);
  if (root && isInside(root, project))
    fail(
      'nested-worktree',
      'The project directory is a task worktree. Start the task from the original project.',
    );
  const repository = await repositoryRoot(project, signal);
  if (repository !== project)
    fail(
      'not-repository-root',
      'Choose the top-level directory of the Git repository.',
    );
  if (isInside(repository, realPathOf(dataDirectory)))
    fail(
      'data-inside-project',
      'The data directory is inside the project. Task worktrees would be nested in it.',
    );
  const base = await headCommit(repository, signal);
  const shortId = runId.slice(0, 8).toLowerCase();
  const branch = `nesvo/${slug}-${shortId}`;
  const worktreeRoot = worktreesRoot(dataDirectory, true);
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
  return { worktree: realPathOf(worktree), branch, base };
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
  const result = await runGit({
    args: [
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
