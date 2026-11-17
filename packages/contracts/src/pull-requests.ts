import { z } from 'zod';

export const pullRequestLimits = {
  listItems: 100,
  files: 300,
  patchBytes: 200 * 1024,
  threads: 200,
  threadComments: 100,
  commits: 250,
  timelineItems: 300,
  checks: 100,
  bodyLength: 65_536,
  commentLength: 65_536,
} as const;

export const GITHUB_REPOSITORY_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:[/?#].*)?$/;

export const githubRepositorySchema = z
  .string()
  .trim()
  .regex(GITHUB_REPOSITORY_PATTERN, 'Use owner/name.');

export const pullRequestReferenceSchema = z.strictObject({
  repository: githubRepositorySchema,
  number: z.number().int().positive().max(999_999_999),
});
export type PullRequestReference = z.infer<typeof pullRequestReferenceSchema>;

export function parsePullRequestUrl(text: string): PullRequestReference | null {
  const match = PULL_REQUEST_URL_PATTERN.exec(text.trim());
  if (!match) return null;
  const parsed = pullRequestReferenceSchema.safeParse({
    repository: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
  });
  return parsed.success ? parsed.data : null;
}

const pathSchema = z.string().trim().max(4096);
const textSchema = z.string().max(pullRequestLimits.bodyLength);
const timestampSchema = z.iso.datetime({ offset: true });
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const pullRequestActorSchema = z.strictObject({
  login: z.string().max(100),
  isBot: z.boolean(),
});
export type PullRequestActor = z.infer<typeof pullRequestActorSchema>;

export const pullRequestStateSchema = z.enum(['open', 'closed', 'merged']);
export const pullRequestChecksStateSchema = z.enum([
  'none',
  'pending',
  'passing',
  'failing',
]);
export const pullRequestReviewDecisionSchema = z.enum([
  'approved',
  'changes-requested',
  'review-required',
  'none',
]);

export const pullRequestSummarySchema = z.strictObject({
  repository: githubRepositorySchema,
  number: z.number().int().positive(),
  title: z.string().max(1024),
  url: z.url(),
  state: pullRequestStateSchema,
  isDraft: z.boolean(),
  author: pullRequestActorSchema.nullable(),
  headRefName: z.string().max(255),
  baseRefName: z.string().max(255),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  checks: pullRequestChecksStateSchema,
  reviewDecision: pullRequestReviewDecisionSchema,
  updatedAt: timestampSchema,
});
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export const pullRequestListScopeSchema = z.enum([
  'authored',
  'review-requested',
  'open',
]);
export type PullRequestListScope = z.infer<typeof pullRequestListScopeSchema>;

export const listPullRequestsSchema = z
  .strictObject({
    directory: pathSchema.optional(),
    repository: githubRepositorySchema.optional(),
    scope: pullRequestListScopeSchema.default('open'),
    query: z.string().trim().max(200).optional(),
  })
  .refine(value => !!value.directory || !!value.repository, {
    message: 'Choose a repository or a project folder.',
  });
export type ListPullRequestsInput = z.input<typeof listPullRequestsSchema>;

export const pullRequestListSchema = z.strictObject({
  repository: githubRepositorySchema,
  items: z.array(pullRequestSummarySchema).max(pullRequestLimits.listItems),
  truncated: z.boolean(),
});
export type PullRequestList = z.infer<typeof pullRequestListSchema>;

export const pullRequestCheckSchema = z.strictObject({
  name: z.string().max(300),
  status: z.enum(['queued', 'in-progress', 'completed']),
  conclusion: z
    .enum([
      'success',
      'failure',
      'neutral',
      'cancelled',
      'skipped',
      'timed-out',
      'action-required',
      'stale',
    ])
    .nullable(),
  url: z.url().nullable(),
});
export type PullRequestCheck = z.infer<typeof pullRequestCheckSchema>;

export const pullRequestCommitSchema = z.strictObject({
  oid: shaSchema,
  headline: z.string().max(1024),
  author: z.string().max(200),
  committedAt: timestampSchema,
});
export type PullRequestCommit = z.infer<typeof pullRequestCommitSchema>;

export const pullRequestTimelineItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('comment'),
    id: z.string().max(200),
    author: pullRequestActorSchema.nullable(),
    body: textSchema,
    createdAt: timestampSchema,
    url: z.url().nullable(),
  }),
  z.strictObject({
    kind: z.literal('review'),
    id: z.string().max(200),
    author: pullRequestActorSchema.nullable(),
    state: z.enum([
      'approved',
      'changes-requested',
      'commented',
      'dismissed',
      'pending',
    ]),
    body: textSchema,
    createdAt: timestampSchema,
  }),
  z.strictObject({
    kind: z.literal('commit'),
    oid: shaSchema,
    headline: z.string().max(1024),
    author: z.string().max(200),
    createdAt: timestampSchema,
  }),
]);
export type PullRequestTimelineItem = z.infer<
  typeof pullRequestTimelineItemSchema
>;

export const pullRequestSchema = pullRequestSummarySchema.extend({
  body: textSchema,
  headSha: shaSchema,
  changedFiles: z.number().int().nonnegative(),
  mergeable: z.enum(['mergeable', 'conflicting', 'unknown']),
  mergeStateStatus: z.string().max(40),
  reviewers: z.array(pullRequestActorSchema).max(100),
  labels: z.array(z.string().max(100)).max(100),
  checkRuns: z.array(pullRequestCheckSchema).max(pullRequestLimits.checks),
  commits: z.array(pullRequestCommitSchema).max(pullRequestLimits.commits),
  timeline: z
    .array(pullRequestTimelineItemSchema)
    .max(pullRequestLimits.timelineItems),
  viewerCanMerge: z.boolean(),
  viewerCanReview: z.boolean(),
  allowedMergeMethods: z.array(z.enum(['squash', 'merge', 'rebase'])).max(3),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const pullRequestFileSchema = z.strictObject({
  path: pathSchema,
  previousPath: pathSchema.nullable(),
  status: z.enum([
    'added',
    'removed',
    'modified',
    'renamed',
    'copied',
    'changed',
    'unchanged',
  ]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(pullRequestLimits.patchBytes).nullable(),
  patchTruncated: z.boolean(),
});
export type PullRequestFile = z.infer<typeof pullRequestFileSchema>;

export const pullRequestFilesSchema = z.strictObject({
  reference: pullRequestReferenceSchema,
  headSha: shaSchema,
  files: z.array(pullRequestFileSchema).max(pullRequestLimits.files),
  truncated: z.boolean(),
});
export type PullRequestFiles = z.infer<typeof pullRequestFilesSchema>;

export const pullRequestThreadCommentSchema = z.strictObject({
  id: z.string().max(200),
  author: pullRequestActorSchema.nullable(),
  body: textSchema,
  createdAt: timestampSchema,
  url: z.url().nullable(),
});
export type PullRequestThreadComment = z.infer<
  typeof pullRequestThreadCommentSchema
>;

export const pullRequestThreadSchema = z.strictObject({
  id: z.string().min(1).max(200),
  path: pathSchema,
  line: z.number().int().positive().nullable(),
  side: z.enum(['left', 'right']).nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanReply: z.boolean(),
  comments: z
    .array(pullRequestThreadCommentSchema)
    .max(pullRequestLimits.threadComments),
});
export type PullRequestThread = z.infer<typeof pullRequestThreadSchema>;

export const pullRequestThreadsSchema = z.strictObject({
  reference: pullRequestReferenceSchema,
  threads: z.array(pullRequestThreadSchema).max(pullRequestLimits.threads),
  truncated: z.boolean(),
});
export type PullRequestThreads = z.infer<typeof pullRequestThreadsSchema>;

export const readPullRequestSchema = pullRequestReferenceSchema;
export type ReadPullRequestInput = z.infer<typeof readPullRequestSchema>;

const commentBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(pullRequestLimits.commentLength);

export const pullRequestActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('comment'), body: commentBodySchema }),
  z.strictObject({
    action: z.literal('review'),
    event: z.enum(['approve', 'request-changes', 'comment']),
    body: z.string().trim().max(pullRequestLimits.commentLength),
  }),
  z.strictObject({
    action: z.literal('reply-thread'),
    threadId: z.string().min(1).max(200),
    body: commentBodySchema,
  }),
  z.strictObject({
    action: z.literal('resolve-thread'),
    threadId: z.string().min(1).max(200),
    resolved: z.boolean(),
  }),
  z
    .strictObject({
      action: z.literal('line-comment'),
      commitId: shaSchema,
      path: pathSchema.min(1),
      side: z.enum(['left', 'right']),
      line: z.number().int().positive(),
      startLine: z.number().int().positive().nullable().default(null),
      body: commentBodySchema,
    })
    .refine(value => value.startLine === null || value.startLine < value.line, {
      message: 'A comment range must start before its last line.',
    }),
  z.strictObject({
    action: z.literal('merge'),
    method: z.enum(['squash', 'merge', 'rebase']),
    expectedHeadSha: shaSchema,
  }),
  z.strictObject({
    action: z.literal('checkout'),
    sessionId: z.uuid(),
  }),
]);
export type PullRequestAction = z.input<typeof pullRequestActionSchema>;

export const actOnPullRequestSchema = z.strictObject({
  actionId: z.uuid(),
  reference: pullRequestReferenceSchema,
  action: pullRequestActionSchema,
});
export type ActOnPullRequestInput = z.input<typeof actOnPullRequestSchema>;

export const pullRequestActionResultSchema = z.strictObject({
  actionId: z.uuid(),
  action: z.enum([
    'comment',
    'review',
    'reply-thread',
    'resolve-thread',
    'line-comment',
    'merge',
    'checkout',
  ]),
  detail: z.string().max(1000).nullable(),
});
export type PullRequestActionResult = z.infer<
  typeof pullRequestActionResultSchema
>;

export const linkSessionPullRequestSchema = z.strictObject({
  sessionId: z.uuid(),
  pullRequest: pullRequestReferenceSchema.nullable(),
});
export type LinkSessionPullRequestInput = z.infer<
  typeof linkSessionPullRequestSchema
>;

export const findSessionPullRequestSchema = z.strictObject({
  sessionId: z.uuid(),
});
export type FindSessionPullRequestInput = z.infer<
  typeof findSessionPullRequestSchema
>;
