import type { Session } from '@nesvo/contracts';
import { SessionError } from '../sessions/session-error';
import {
  currentGitBranch,
  readHeadCommit,
  repositoryGitDirectory,
  repositoryRoot,
  runGit,
} from './isolation';

export const workerGit = (
  cwd: string,
  signal: AbortSignal,
  args: string[],
  maxOutputBytes?: number,
) => runGit({ cwd, signal, args, maxOutputBytes, timeoutMs: 20_000 });

export async function cleanWorkerCheckout(
  directory: string,
  signal: AbortSignal,
) {
  const status = await workerGit(directory, signal, [
    '-c',
    'core.fsmonitor=false',
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  ]);
  if (status.code !== 0)
    throw new SessionError('unavailable', 'Git could not check the worktree.');
  return !status.stdout && !status.outputTruncated;
}

export async function inspectWorkerWorktree(
  parent: Session,
  child: Session,
  signal: AbortSignal,
) {
  const { branch, base, workerTargetBranch } = child.worktree!;
  const targetBranch = workerTargetBranch!;
  const target = await repositoryRoot(parent.directory, signal);
  const [
    targetGit,
    childGit,
    checkedOut,
    workerBranch,
    targetHead,
    head,
    clean,
    patch,
  ] = await Promise.all([
    repositoryGitDirectory(target, signal),
    repositoryGitDirectory(child.directory, signal),
    workerGit(target, signal, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    currentGitBranch(child.directory, signal),
    readHeadCommit(target, signal),
    readHeadCommit(child.directory, signal),
    cleanWorkerCheckout(child.directory, signal),
    workerGit(
      child.directory,
      signal,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        base,
        'HEAD',
        '--',
      ],
      256_000,
    ),
  ]);
  if (targetGit !== childGit || workerBranch !== branch || patch.code !== 0)
    throw new SessionError(
      'invalid-request',
      'The worker branch or its Git repository changed.',
    );
  return {
    target,
    result: {
      branch,
      targetBranch,
      head,
      targetHead,
      dirty: !clean,
      canMerge:
        clean &&
        checkedOut.code === 0 &&
        checkedOut.stdout.trim() === targetBranch,
      diff: patch.stdout.slice(0, 256_000),
      truncated: patch.outputTruncated,
      resolved: false,
    },
  };
}

export async function mergeWorkerCommit(
  target: string,
  head: string,
  targetHead: string,
  targetBranch: string,
  signal: AbortSignal,
) {
  if (!(await cleanWorkerCheckout(target, signal)))
    throw new SessionError(
      'invalid-request',
      'Commit or stash changes in the coordinator checkout before merging.',
    );
  const preflight = await workerGit(target, signal, [
    'merge-tree',
    '--write-tree',
    targetHead,
    head,
  ]);
  if (preflight.code !== 0)
    throw new SessionError(
      'invalid-request',
      'Git could not merge the branches cleanly. Both worktrees are available.',
    );
  if (
    (await readHeadCommit(target, signal)) !== targetHead ||
    (await currentGitBranch(target, signal)) !== targetBranch
  )
    throw new SessionError(
      'invalid-request',
      'The coordinator branch changed. Review the worker result again.',
    );
  const result = await workerGit(target, signal, [
    '-c',
    'core.hooksPath=',
    '-c',
    'merge.autoStash=false',
    '-c',
    'rerere.enabled=false',
    'merge',
    '--ff',
    '--no-edit',
    '--no-gpg-sign',
    '--no-overwrite-ignore',
    '--',
    head,
  ]);
  if (result.code !== 0)
    throw new SessionError(
      'unavailable',
      'Git could not finish the merge. Inspect the coordinator checkout before retrying.',
    );
}
