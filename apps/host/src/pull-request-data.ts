import {
  pullRequestLimits as limits,
  pullRequestFileSchema,
  type PullRequest,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestCommit,
  type PullRequestFile,
  type PullRequestSummary,
  type PullRequestThread,
  type PullRequestThreadComment,
  type PullRequestTimelineItem,
} from '@nesvo/contracts';
import { z } from 'zod';

export const countSchema = z.number().int().nonnegative();
export const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const timestamp = z.iso.datetime({ offset: true });
const actorSchema = z
  .object({
    login: z.string(),
    is_bot: z.boolean().optional(),
    __typename: z.string().optional(),
  })
  .nullable();
const url = z
  .url()
  .nullish()
  .or(z.literal(''))
  .transform(value => value || null);
const checkSchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullish(),
    detailsUrl: url,
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    state: z.string(),
    targetUrl: url,
  }),
]);

export const summaryFields = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'author',
  'headRefName',
  'baseRefName',
  'additions',
  'deletions',
  'statusCheckRollup',
  'reviewDecision',
  'updatedAt',
].join(',');

export const summarySchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.url(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  author: actorSchema,
  headRefName: z.string(),
  baseRefName: z.string(),
  additions: countSchema,
  deletions: countSchema,
  statusCheckRollup: z.array(checkSchema).nullable(),
  reviewDecision: z
    .enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', ''])
    .nullable(),
  updatedAt: timestamp,
});

const commentSchema = z.object({
  id: z.string(),
  author: actorSchema,
  body: z.string(),
  createdAt: timestamp,
  url,
});

export const detailFields = [
  summaryFields,
  'body',
  'headRefOid',
  'changedFiles',
  'mergeable',
  'mergeStateStatus',
  'reviewRequests',
  'reviews',
  'labels',
  'commits',
  'comments',
].join(',');

export const detailSchema = summarySchema.extend({
  body: z.string(),
  headRefOid: shaSchema,
  changedFiles: countSchema,
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  mergeStateStatus: z.string(),
  reviewRequests: z
    .array(
      z.object({
        login: z.string().optional(),
        slug: z.string().optional(),
        __typename: z.string().optional(),
      }),
    )
    .nullable(),
  reviews: z
    .array(
      z.object({
        id: z.string(),
        author: actorSchema,
        state: z.enum([
          'APPROVED',
          'CHANGES_REQUESTED',
          'COMMENTED',
          'DISMISSED',
          'PENDING',
        ]),
        body: z.string(),
        submittedAt: timestamp.nullish(),
      }),
    )
    .nullable(),
  labels: z.array(z.object({ name: z.string() })).nullable(),
  commits: z.array(
    z.object({
      oid: shaSchema,
      messageHeadline: z.string(),
      committedDate: timestamp,
      authors: z.array(z.object({ login: z.string(), name: z.string() })),
    }),
  ),
  comments: z.array(commentSchema).nullable(),
});

export const permissionSchema = z.object({
  viewerPermission: z
    .enum(['READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN', ''])
    .nullable(),
});
export const mergeMethodsSchema = z.object({
  allow_squash_merge: z.boolean().optional(),
  allow_merge_commit: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
});
export const viewerSchema = z.object({ login: z.string().min(1) });

function actor(value: z.infer<typeof actorSchema>): PullRequestActor | null {
  return value?.login
    ? {
        login: value.login.slice(0, 100),
        isBot:
          value.is_bot ??
          (value.__typename === 'Bot' || /\[bot\]$/i.test(value.login)),
      }
    : null;
}

const conclusions = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
  NEUTRAL: 'neutral',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  TIMED_OUT: 'timed-out',
  ACTION_REQUIRED: 'action-required',
  STARTUP_FAILURE: 'failure',
  STALE: 'stale',
} as const;

function check(raw: z.infer<typeof checkSchema>): PullRequestCheck {
  const state = raw.__typename === 'CheckRun' ? raw.conclusion : raw.state;
  const conclusion =
    state && Object.hasOwn(conclusions, state)
      ? conclusions[state as keyof typeof conclusions]
      : null;
  if (raw.__typename === 'StatusContext')
    return {
      name: raw.context.slice(0, 300),
      status: conclusion ? 'completed' : 'queued',
      conclusion,
      url: raw.targetUrl,
    };
  return {
    name: raw.name.slice(0, 300),
    status:
      raw.status === 'COMPLETED'
        ? 'completed'
        : raw.status === 'IN_PROGRESS'
          ? 'in-progress'
          : 'queued',
    conclusion,
    url: raw.detailsUrl,
  };
}

function checksState(checks: PullRequestCheck[]): PullRequestSummary['checks'] {
  if (checks.length === 0) return 'none';
  if (
    checks.some(
      value =>
        value.conclusion &&
        !['success', 'neutral', 'skipped'].includes(value.conclusion),
    )
  )
    return 'failing';
  return checks.every(value => value.status === 'completed' && value.conclusion)
    ? 'passing'
    : 'pending';
}

const decisions = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
  '': 'none',
} as const;
const states = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' } as const;
const mergeable = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
  UNKNOWN: 'unknown',
} as const;
const reviewStates = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
} as const;

export function summary(
  raw: z.infer<typeof summarySchema>,
  repository: string,
): PullRequestSummary {
  return {
    repository,
    number: raw.number,
    title: raw.title.slice(0, 1024),
    url: raw.url,
    state: states[raw.state],
    isDraft: raw.isDraft,
    author: actor(raw.author),
    headRefName: raw.headRefName.slice(0, 255),
    baseRefName: raw.baseRefName.slice(0, 255),
    additions: raw.additions,
    deletions: raw.deletions,
    checks: checksState((raw.statusCheckRollup ?? []).map(check)),
    reviewDecision: decisions[raw.reviewDecision ?? ''],
    updatedAt: raw.updatedAt,
  };
}

function comment(raw: z.infer<typeof commentSchema>): PullRequestThreadComment {
  return {
    ...raw,
    id: raw.id.slice(0, 200),
    body: raw.body.slice(0, limits.bodyLength),
    author: actor(raw.author),
  };
}

export function detail(
  raw: z.infer<typeof detailSchema>,
  repository: string,
  viewer: string,
  permission: z.infer<typeof permissionSchema>['viewerPermission'],
  methods: z.infer<typeof mergeMethodsSchema>,
): PullRequest {
  const commits: PullRequestCommit[] = raw.commits
    .slice(0, limits.commits)
    .map(commit => ({
      oid: commit.oid,
      headline: commit.messageHeadline.slice(0, 1024),
      author: (commit.authors[0]?.login || commit.authors[0]?.name || '').slice(
        0,
        200,
      ),
      committedAt: commit.committedDate,
    }));
  const timeline: PullRequestTimelineItem[] = [
    ...(raw.comments ?? []).map(value => ({
      kind: 'comment' as const,
      ...comment(value),
    })),
    ...commits.map(({ committedAt, ...commit }) => ({
      kind: 'commit' as const,
      ...commit,
      createdAt: committedAt,
    })),
  ];
  for (const review of raw.reviews ?? []) {
    if (!review.submittedAt || review.state === 'PENDING') continue;
    timeline.push({
      kind: 'review',
      id: review.id.slice(0, 200),
      author: actor(review.author),
      state: reviewStates[review.state],
      body: review.body.slice(0, limits.bodyLength),
      createdAt: review.submittedAt,
    });
  }
  timeline.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const allowedMergeMethods: PullRequest['allowedMergeMethods'] = [];
  if (methods.allow_squash_merge) allowedMergeMethods.push('squash');
  if (methods.allow_merge_commit) allowedMergeMethods.push('merge');
  if (methods.allow_rebase_merge) allowedMergeMethods.push('rebase');

  return {
    ...summary(raw, repository),
    body: raw.body.slice(0, limits.bodyLength),
    headSha: raw.headRefOid,
    changedFiles: raw.changedFiles,
    mergeable: mergeable[raw.mergeable],
    mergeStateStatus: raw.mergeStateStatus.slice(0, 40),
    reviewers: (raw.reviewRequests ?? [])
      .flatMap(value => {
        const reviewer = actor({
          ...value,
          login: value.login || value.slug || '',
        });
        return reviewer ? [reviewer] : [];
      })
      .slice(0, 100),
    labels: (raw.labels ?? [])
      .slice(0, 100)
      .map(label => label.name.slice(0, 100)),
    checkRuns: (raw.statusCheckRollup ?? []).slice(0, limits.checks).map(check),
    commits,
    timeline: timeline.slice(-limits.timelineItems),
    viewerCanMerge:
      permission === 'WRITE' ||
      permission === 'MAINTAIN' ||
      permission === 'ADMIN',
    viewerCanReview: viewer.toLowerCase() !== raw.author?.login.toLowerCase(),
    allowedMergeMethods,
  };
}

export const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().nullish(),
  status: pullRequestFileSchema.shape.status,
  additions: countSchema,
  deletions: countSchema,
  patch: z.string().nullish(),
});

export function file(raw: z.infer<typeof fileSchema>): PullRequestFile {
  const patch = raw.patch == null ? null : Buffer.from(raw.patch);
  let end = Math.min(patch?.length ?? 0, limits.patchBytes);
  if (patch && patch.length > end) {
    while ((patch[end]! & 0xc0) === 0x80) end--;
  }
  return {
    path: raw.filename.slice(0, 4096),
    previousPath: raw.previous_filename?.slice(0, 4096) ?? null,
    status: raw.status,
    additions: raw.additions,
    deletions: raw.deletions,
    patch: patch?.subarray(0, end).toString('utf8') ?? null,
    patchTruncated: patch !== null && patch.length > end,
  };
}

const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().min(1).max(1024).nullable(),
});
const threadSchema = z.object({
  id: z.string().min(1).max(200),
  path: z.string(),
  line: z.number().int().positive().nullable(),
  diffSide: z.enum(['LEFT', 'RIGHT']).nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  viewerCanResolve: z.boolean(),
  viewerCanUnresolve: z.boolean().optional(),
  viewerCanReply: z.boolean(),
  comments: z.object({
    nodes: z.array(commentSchema),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
export const threadsPageSchema = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            reviewThreads: z.object({ nodes: z.array(threadSchema), pageInfo }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

export function thread(raw: z.infer<typeof threadSchema>): PullRequestThread {
  return {
    id: raw.id,
    path: raw.path.slice(0, 4096),
    line: raw.line,
    side:
      raw.diffSide === 'LEFT'
        ? 'left'
        : raw.diffSide === 'RIGHT'
          ? 'right'
          : null,
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated,
    viewerCanResolve: raw.isResolved
      ? (raw.viewerCanUnresolve ?? raw.viewerCanResolve)
      : raw.viewerCanResolve,
    viewerCanReply: raw.viewerCanReply,
    comments: raw.comments.nodes.slice(0, limits.threadComments).map(comment),
  };
}
