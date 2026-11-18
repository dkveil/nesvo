import { z } from 'zod';
import {
  pullRequestReferenceSchema,
  pullRequestStateSchema,
} from './pull-requests';
import { sessionWorktreeSchema } from './sessions';

export const mergedCleanupLimits = {
  changes: 50,
  unpushed: 20,
  sessions: 100,
} as const;

export const readMergedWorktreeCleanupSchema = z.strictObject({
  sessionId: z.uuid(),
});
export type ReadMergedWorktreeCleanupInput = z.infer<
  typeof readMergedWorktreeCleanupSchema
>;

export const finishMergedWorktreeSchema = z.strictObject({
  sessionId: z.uuid(),
  revision: z.number().int().nonnegative(),
});
export type FinishMergedWorktreeInput = z.infer<
  typeof finishMergedWorktreeSchema
>;

export const mergedCleanupBlockerSchema = z.enum([
  'not-merged',
  'uncommitted-changes',
  'unpushed-commits',
  'session-busy',
  'worktree-unavailable',
]);
export type MergedCleanupBlocker = z.infer<typeof mergedCleanupBlockerSchema>;

export const mergedCleanupBranchSchema = z.enum([
  'delete',
  'missing',
  'other-branch',
  'not-merged',
]);
export type MergedCleanupBranch = z.infer<typeof mergedCleanupBranchSchema>;

const shaSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

export const mergedWorktreeCleanupSchema = z.strictObject({
  sessionId: z.uuid(),
  pullRequest: z.strictObject({
    reference: pullRequestReferenceSchema,
    state: pullRequestStateSchema,
    headRefName: z.string().max(255),
    headSha: shaSchema.nullable(),
  }),
  worktree: z.strictObject({
    state: sessionWorktreeSchema.shape.state,
    branch: sessionWorktreeSchema.shape.branch,
  }),
  changes: z.array(z.string().max(4096)).max(mergedCleanupLimits.changes),
  changesTruncated: z.boolean(),
  unpushed: z
    .array(z.strictObject({ sha: shaSchema, subject: z.string().max(200) }))
    .max(mergedCleanupLimits.unpushed),
  unpushedTruncated: z.boolean(),
  localFiles: z.number().int().nonnegative(),
  branch: mergedCleanupBranchSchema,
  blockers: z.array(mergedCleanupBlockerSchema).max(8),
});
export type MergedWorktreeCleanup = z.infer<typeof mergedWorktreeCleanupSchema>;

export const mergedWorktreeFinishSchema = z.strictObject({
  outcome: z.enum(['finished', 'blocked']),
  branchDeleted: z.boolean(),
  archived: z.boolean(),
  cleanup: mergedWorktreeCleanupSchema,
});
export type MergedWorktreeFinish = z.infer<typeof mergedWorktreeFinishSchema>;

export const mergedCleanupBlockerMessages: Record<
  MergedCleanupBlocker,
  string
> = {
  'not-merged': 'The linked pull request is not merged.',
  'uncommitted-changes': 'The worktree has uncommitted changes.',
  'unpushed-commits':
    'The worktree has commits that are not on GitHub or in the merged pull request.',
  'session-busy': 'The session is working. Stop it before finishing.',
  'worktree-unavailable': 'The worktree is no longer registered with Git.',
};

export const mergedCleanupBranchMessages: Record<MergedCleanupBranch, string> =
  {
    delete: 'The local branch will be deleted.',
    missing: 'The local branch no longer exists.',
    'other-branch':
      'The pull request comes from another branch, so the local branch is kept.',
    'not-merged': 'The local branch is kept until the pull request is merged.',
  };
