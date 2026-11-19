import type {
  FinishMergedWorktreeInput,
  FinishSessionWorktreeInput,
  MergedCleanupBlocker,
  MergedCleanupBranch,
  MergedWorktreeCleanup,
  MergedWorktreeFinish,
  PullRequestReference,
  ReadMergedWorktreeCleanupInput,
  Session,
} from '@nesvo/contracts';
import {
  deleteMergedSessionBranch,
  inspectMergedSessionWorktree,
  sessionCheckout,
  WorkspaceIsolationError,
  type MergedWorktreeInspection,
} from '../workspace/isolation';
import { PullRequestError } from '../process/github-cli';
import { SessionError } from './session-error';

type PullRequestMergeState = {
  state: 'open' | 'closed' | 'merged';
  headRefName: string;
  headSha: string | null;
};

type MergedCleanupParams = {
  dataDirectory: string;
  snapshot: (sessionId: string) => Session | undefined;
  isRunning: (sessionId: string) => boolean;
  mergeState: (
    reference: PullRequestReference,
  ) => Promise<PullRequestMergeState>;
  finishWorktree: (
    input: FinishSessionWorktreeInput,
    signal: AbortSignal,
    removal: { allowsIgnoredFiles?: boolean; actionId?: string },
  ) => Promise<Session>;
  archive: (sessionId: string) => Session;
};

type CleanupTarget = {
  session: Session;
  worktree: NonNullable<Session['worktree']>;
  reference: PullRequestReference;
};

const emptyInspection: MergedWorktreeInspection = {
  registered: false,
  changes: [],
  changesTruncated: false,
  localFiles: 0,
  unpushed: [],
  unpushedTruncated: false,
  branchExists: false,
};

const branchPlan = (
  pullRequest: PullRequestMergeState,
  branch: string,
  inspection: MergedWorktreeInspection,
): MergedCleanupBranch => {
  if (pullRequest.state !== 'merged') return 'not-merged';
  if (pullRequest.headRefName !== branch) return 'other-branch';
  return inspection.branchExists ? 'delete' : 'missing';
};

const blockersOf = (
  pullRequest: PullRequestMergeState,
  inspection: MergedWorktreeInspection,
  running: boolean,
): MergedCleanupBlocker[] => [
  ...(pullRequest.state === 'merged' ? [] : ['not-merged' as const]),
  ...(running ? ['session-busy' as const] : []),
  ...(inspection.changes.length > 0 || inspection.changesTruncated
    ? ['uncommitted-changes' as const]
    : []),
  ...(inspection.unpushed.length > 0 ? ['unpushed-commits' as const] : []),
];

export class MergedWorktreeCleanups {
  private readonly finishing = new Map<string, Promise<MergedWorktreeFinish>>();

  constructor(private readonly params: MergedCleanupParams) {}

  async read(
    input: ReadMergedWorktreeCleanupInput,
    signal: AbortSignal,
  ): Promise<MergedWorktreeCleanup> {
    return (await this.inspect(this.target(input.sessionId), signal)).cleanup;
  }

  finish(
    input: FinishMergedWorktreeInput,
    signal: AbortSignal,
    actionId?: string,
  ): Promise<MergedWorktreeFinish> {
    const pending = this.finishing.get(input.sessionId);
    if (pending) return pending;
    const run = this.run(input, signal, actionId).finally(() =>
      this.finishing.delete(input.sessionId),
    );
    this.finishing.set(input.sessionId, run);
    return run;
  }

  private async run(
    input: FinishMergedWorktreeInput,
    signal: AbortSignal,
    actionId?: string,
  ): Promise<MergedWorktreeFinish> {
    const target = this.target(input.sessionId);
    if (
      target.worktree.state !== 'removed' &&
      target.session.revision !== input.revision
    )
      throw new SessionError(
        'invalid-request',
        'The session changed. Review the clean-up again.',
      );
    const { cleanup, pullRequest } = await this.inspect(target, signal);
    if (cleanup.blockers.length > 0)
      return {
        outcome: 'blocked',
        branchDeleted: false,
        archived: false,
        cleanup,
      };
    if (target.worktree.state !== 'removed')
      await this.params.finishWorktree(
        {
          sessionId: target.session.id,
          action: { kind: 'remove', force: false },
        },
        signal,
        { allowsIgnoredFiles: true, actionId },
      );
    const branchDeleted =
      cleanup.branch === 'delete' &&
      !target.worktree.binding &&
      pullRequest.state === 'merged' &&
      (await deleteMergedSessionBranch({
        projectDirectory: target.worktree.projectDirectory,
        gitDirectory: this.gitDirectory(target.session.id),
        branch: target.worktree.branch,
        signal,
      }));
    const archived = !!this.params.archive(target.session.id).archivedAt;
    return { outcome: 'finished', branchDeleted, archived, cleanup };
  }

  private target(sessionId: string): CleanupTarget {
    const session = this.params.snapshot(sessionId);
    if (!session) throw new SessionError('not-found', 'Session not found.');
    if (!session.worktree)
      throw new SessionError(
        'invalid-request',
        'This session has no managed worktree.',
      );
    if (!session.pullRequest)
      throw new SessionError(
        'invalid-request',
        'This session has no linked pull request.',
      );
    return {
      session,
      worktree: session.worktree,
      reference: session.pullRequest,
    };
  }

  private gitDirectory(sessionId: string): string | undefined {
    return sessionCheckout(this.params.dataDirectory, sessionId)?.gitDirectory;
  }

  private async inspect(
    { session, worktree, reference }: CleanupTarget,
    signal: AbortSignal,
  ) {
    const pullRequest = await this.params
      .mergeState(reference)
      .catch((error: unknown) => {
        if (error instanceof PullRequestError)
          throw new SessionError(
            error.code,
            `GitHub could not report the pull request state. ${error.message}`,
          );
        throw error;
      });
    let inspection = emptyInspection;
    let unavailable = false;
    try {
      inspection = await inspectMergedSessionWorktree({
        projectDirectory: worktree.projectDirectory,
        dataDirectory: this.params.dataDirectory,
        worktree: session.directory,
        gitDirectory: this.gitDirectory(session.id),
        binding: worktree.binding,
        branch: worktree.branch,
        mergedHead: pullRequest.headSha,
        signal,
      });
    } catch (error) {
      if (!(error instanceof WorkspaceIsolationError)) throw error;
      if (error.code === 'cancelled') throw error;
      unavailable = true;
    }
    const blockers = blockersOf(
      pullRequest,
      inspection,
      this.params.isRunning(session.id),
    );
    const cleanup: MergedWorktreeCleanup = {
      sessionId: session.id,
      pullRequest: {
        reference,
        state: pullRequest.state,
        headRefName: pullRequest.headRefName,
        headSha: pullRequest.headSha,
      },
      worktree: { state: worktree.state, branch: worktree.branch },
      changes: inspection.changes,
      changesTruncated: inspection.changesTruncated,
      unpushed: inspection.unpushed,
      unpushedTruncated: inspection.unpushedTruncated,
      localFiles: inspection.localFiles,
      branch: worktree.binding
        ? 'keep'
        : branchPlan(pullRequest, worktree.branch, inspection),
      blockers: unavailable ? [...blockers, 'worktree-unavailable'] : blockers,
    };
    return { cleanup, pullRequest };
  }
}
