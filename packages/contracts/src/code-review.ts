import { z } from 'zod';
import {
  githubRepositorySchema,
  pullRequestReferenceSchema,
} from './pull-requests';
import { reasoningEffortSchema } from './reasoning-effort';
import { claudeModelSchema, providerSchema } from './sessions';

export const codeReviewLimits = {
  profiles: 50,
  conventions: 500,
  conventionText: 2000,
  drafts: 500,
  findings: 100,
  findingBody: 8000,
  suggestion: 8000,
  summary: 8000,
  reviewBody: 60_000,
  bulkReviews: 20,
  automationReviews: 5,
  promptPatchBytes: 160 * 1024,
  error: 2000,
} as const;

export const reviewSeveritySchema = z.enum([
  'info',
  'minor',
  'major',
  'critical',
]);
export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>;
export const REVIEW_SEVERITY_ORDER = reviewSeveritySchema.options;

export const reviewFindingTypeSchema = z.enum([
  'comment',
  'suggestion',
  'question',
  'nit',
]);
export type ReviewFindingType = z.infer<typeof reviewFindingTypeSchema>;

export const reviewToneSchema = z.enum(['neutral', 'friendly', 'direct']);
export type ReviewTone = z.infer<typeof reviewToneSchema>;

const idSchema = z.uuid();
const revisionSchema = z.number().int().positive();
const timestampSchema = z.iso.datetime();
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const singleLineSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]+$/);
const textSchema = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);

const reviewerProfileShape = {
  name: singleLineSchema(80),
  provider: providerSchema,
  model: z.string().trim().min(1).max(200),
  effort: reasoningEffortSchema.nullable(),
  findingTypes: z
    .array(reviewFindingTypeSchema)
    .min(1)
    .max(reviewFindingTypeSchema.options.length)
    .refine(
      types => new Set(types).size === types.length,
      'Choose each finding type once.',
    ),
  minimumSeverity: reviewSeveritySchema,
  maxFindings: z.number().int().min(1).max(codeReviewLimits.findings),
  tone: reviewToneSchema,
  language: singleLineSchema(40),
  includeSummary: z.boolean(),
};

const enforceProfileProvider = (
  value: { provider: string; model: string; effort: string | null },
  context: z.RefinementCtx,
) => {
  if (
    value.provider === 'Claude Code' &&
    !claudeModelSchema.safeParse(value.model).success
  )
    context.addIssue({
      code: 'custom',
      path: ['model'],
      message: 'Unsupported Claude Code model',
    });
  if (
    value.effort &&
    (value.provider === 'Claude Code' || value.model === 'default')
  )
    context.addIssue({
      code: 'custom',
      path: ['effort'],
      message:
        value.provider === 'Claude Code'
          ? 'Claude Code reviews do not accept a reasoning effort'
          : 'Choose a specific Codex model to set a reasoning effort',
    });
};

export const reviewerProfileSchema = z
  .strictObject({
    id: idSchema,
    revision: revisionSchema,
    ...reviewerProfileShape,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine(enforceProfileProvider);
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;

export const saveReviewerProfileSchema = z
  .strictObject({
    id: idSchema,
    expectedRevision: revisionSchema.nullable(),
    ...reviewerProfileShape,
  })
  .superRefine(enforceProfileProvider);
export type SaveReviewerProfileInput = z.input<
  typeof saveReviewerProfileSchema
>;

export const deleteReviewerProfileSchema = z.strictObject({
  id: idSchema,
  expectedRevision: revisionSchema,
});
export type DeleteReviewerProfileInput = z.infer<
  typeof deleteReviewerProfileSchema
>;

export const reviewConventionLayerSchema = z.enum([
  'global',
  'language',
  'project',
]);
export type ReviewConventionLayer = z.infer<typeof reviewConventionLayerSchema>;

export const REVIEW_LANGUAGE_SCOPE_PATTERN = /^[a-z0-9][a-z0-9+#_-]{0,19}$/;

const isAbsolutePath = (value: string) =>
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);

const reviewConventionShape = {
  layer: reviewConventionLayerSchema,
  scope: z.string().trim().max(4096),
  text: z
    .string()
    .trim()
    .min(1)
    .max(codeReviewLimits.conventionText)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/),
};

const enforceConventionScope = (
  value: { layer: ReviewConventionLayer; scope: string },
  context: z.RefinementCtx,
) => {
  const valid =
    value.layer === 'global'
      ? value.scope === ''
      : value.layer === 'language'
        ? REVIEW_LANGUAGE_SCOPE_PATTERN.test(value.scope)
        : githubRepositorySchema.safeParse(value.scope).success ||
          isAbsolutePath(value.scope);
  if (!valid)
    context.addIssue({
      code: 'custom',
      path: ['scope'],
      message:
        value.layer === 'global'
          ? 'Global conventions have no scope.'
          : value.layer === 'language'
            ? 'Use a file extension such as ts or py.'
            : 'Use owner/name or an absolute project folder.',
    });
};

export const reviewConventionSchema = z
  .strictObject({
    id: idSchema,
    ...reviewConventionShape,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine(enforceConventionScope);
export type ReviewConvention = z.infer<typeof reviewConventionSchema>;

export const saveReviewConventionSchema = z
  .strictObject({ id: idSchema, ...reviewConventionShape })
  .superRefine(enforceConventionScope);
export type SaveReviewConventionInput = z.input<
  typeof saveReviewConventionSchema
>;

export const deleteReviewConventionSchema = z.strictObject({ id: idSchema });
export type DeleteReviewConventionInput = z.infer<
  typeof deleteReviewConventionSchema
>;

export const codeReviewSettingsSchema = z.strictObject({
  profiles: z.array(reviewerProfileSchema).max(codeReviewLimits.profiles),
  conventions: z
    .array(reviewConventionSchema)
    .max(codeReviewLimits.conventions),
});
export type CodeReviewSettings = z.infer<typeof codeReviewSettingsSchema>;

const findingShape = {
  path: z.string().trim().min(1).max(4096),
  startLine: z.number().int().min(1).max(10_000_000),
  endLine: z.number().int().min(1).max(10_000_000),
  severity: reviewSeveritySchema,
  type: reviewFindingTypeSchema,
  body: z.string().trim().min(1).max(codeReviewLimits.findingBody),
  suggestion: z.string().max(codeReviewLimits.suggestion).nullable(),
};

const enforceLineRange = (
  value: { startLine: number; endLine: number },
  context: z.RefinementCtx,
) => {
  if (value.startLine > value.endLine)
    context.addIssue({
      code: 'custom',
      path: ['startLine'],
      message: 'A finding must start on or before its last line.',
    });
};

export const agentReviewFindingSchema = z
  .strictObject(findingShape)
  .superRefine(enforceLineRange);
export type AgentReviewFinding = z.infer<typeof agentReviewFindingSchema>;

export const agentReviewOutputSchema = z.strictObject({
  summary: z.string().max(codeReviewLimits.summary).nullable(),
  findings: z.array(agentReviewFindingSchema).max(codeReviewLimits.findings),
});
export type AgentReviewOutput = z.infer<typeof agentReviewOutputSchema>;

export const agentReviewOutputJsonSchema = () =>
  z.toJSONSchema(agentReviewOutputSchema, { io: 'input' });

export const reviewFindingStateSchema = z.enum([
  'pending',
  'kept',
  'discarded',
]);
export type ReviewFindingState = z.infer<typeof reviewFindingStateSchema>;

export const reviewDraftFindingSchema = z
  .strictObject({
    id: idSchema,
    ...findingShape,
    state: reviewFindingStateSchema,
    edited: z.boolean(),
  })
  .superRefine(enforceLineRange);
export type ReviewDraftFinding = z.infer<typeof reviewDraftFindingSchema>;

export const reviewDraftStatusSchema = z.enum([
  'queued',
  'running',
  'ready',
  'invalid',
  'failed',
  'interrupted',
  'publishing',
  'published',
  'discarded',
]);
export type ReviewDraftStatus = z.infer<typeof reviewDraftStatusSchema>;

export const reviewEventSchema = z.enum([
  'comment',
  'request-changes',
  'approve',
]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

export const reviewDraftProfileSchema = z.strictObject({
  id: idSchema,
  name: reviewerProfileShape.name,
  provider: providerSchema,
  model: reviewerProfileShape.model,
  effort: reviewerProfileShape.effort,
  findingTypes: reviewerProfileShape.findingTypes,
  minimumSeverity: reviewSeveritySchema,
  maxFindings: reviewerProfileShape.maxFindings,
  tone: reviewToneSchema,
  language: reviewerProfileShape.language,
  includeSummary: z.boolean(),
});
export type ReviewDraftProfile = z.infer<typeof reviewDraftProfileSchema>;

export const reviewDraftSchema = z.strictObject({
  id: idSchema,
  revision: revisionSchema,
  reference: pullRequestReferenceSchema,
  title: z.string().max(1024),
  directory: z.string().min(1).max(4096),
  profile: reviewDraftProfileSchema,
  sessionId: idSchema.nullable(),
  scheduledJobId: idSchema.nullable(),
  headSha: shaSchema.nullable(),
  status: reviewDraftStatusSchema,
  error: z.string().max(codeReviewLimits.error).nullable(),
  summary: z.string().max(codeReviewLimits.summary).nullable(),
  findings: z.array(reviewDraftFindingSchema).max(codeReviewLimits.findings),
  filtered: z.number().int().nonnegative(),
  published: z
    .strictObject({
      actionId: idSchema,
      event: reviewEventSchema,
      inline: z.number().int().nonnegative(),
      inBody: z.number().int().nonnegative(),
      headMoved: z.boolean(),
      at: timestampSchema,
    })
    .nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

export const reviewDraftListSchema = z
  .array(reviewDraftSchema)
  .max(codeReviewLimits.drafts);

export const startPullRequestReviewSchema = z.strictObject({
  requestId: idSchema,
  reference: pullRequestReferenceSchema,
  directory: z.string().trim().min(1).max(4096),
  profileId: idSchema,
});
export type StartPullRequestReviewInput = z.infer<
  typeof startPullRequestReviewSchema
>;

export const listPullRequestReviewsSchema = z.strictObject({
  reference: pullRequestReferenceSchema.optional(),
});
export type ListPullRequestReviewsInput = z.infer<
  typeof listPullRequestReviewsSchema
>;

export const updateReviewFindingSchema = z.strictObject({
  draftId: idSchema,
  findingId: idSchema,
  expectedRevision: revisionSchema,
  state: reviewFindingStateSchema.optional(),
  body: z.string().trim().min(1).max(codeReviewLimits.findingBody).optional(),
  suggestion: z.string().max(codeReviewLimits.suggestion).nullable().optional(),
  severity: reviewSeveritySchema.optional(),
  type: reviewFindingTypeSchema.optional(),
});
export type UpdateReviewFindingInput = z.infer<
  typeof updateReviewFindingSchema
>;

export const discardPullRequestReviewSchema = z.strictObject({
  draftId: idSchema,
  expectedRevision: revisionSchema,
});
export type DiscardPullRequestReviewInput = z.infer<
  typeof discardPullRequestReviewSchema
>;

export const publishPullRequestReviewSchema = z.strictObject({
  draftId: idSchema,
  actionId: idSchema,
  expectedRevision: revisionSchema,
  event: reviewEventSchema,
  body: textSchema(codeReviewLimits.reviewBody).transform(value =>
    value.trim(),
  ),
  allowMovedHead: z.boolean().default(false),
});
export type PublishPullRequestReviewInput = z.input<
  typeof publishPullRequestReviewSchema
>;

export const publishPullRequestReviewResultSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('published'),
      draft: reviewDraftSchema,
    }),
    z.strictObject({
      status: z.literal('head-moved'),
      currentHeadSha: shaSchema,
      draft: reviewDraftSchema,
    }),
  ],
);
export type PublishPullRequestReviewResult = z.infer<
  typeof publishPullRequestReviewResultSchema
>;

export const reviewDraftEventSchema = z.strictObject({
  draft: reviewDraftSchema,
});
