import { z } from 'zod';
import { githubRepositorySchema } from './pull-requests';
import { claudeModelSchema, providerSchema } from './sessions';
import { definitionScopeSchema, stepNameSchema } from './workflows/definitions';

export const lessonLimits = {
  incidents: 500,
  listedIncidents: 100,
  incidentSummary: 500,
  incidentDetail: 400,
  incidentDetails: 6,
  proposalIncidents: 60,
  proposedLessons: 10,
  proposals: 300,
  lessonsPerRoot: 200,
  lessonRoots: 100,
  title: 120,
  rule: 1000,
  evidence: 10,
  injectedLessons: 12,
  injectedCharacters: 6000,
  scopeValue: 4096,
  error: 2000,
  minimumReviewDays: 1,
  maximumReviewDays: 365,
  defaultReviewDays: 30,
} as const;

export const LESSON_PROPOSAL_INTERVAL_MS = 24 * 60 * 60_000;
export const LESSON_FOLDER = 'lessons';
export const LESSON_FILE_KIND = 'lesson';
export const OWNER_LESSONS_HEADING = 'Owner lessons';

const idSchema = z.uuid();
const timestampSchema = z.iso.datetime();
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
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/);

export const lessonIncidentKindSchema = z.enum([
  'step-retries-exhausted',
  'session-stuck',
  'plan-rejected',
  'plan-corrected',
  'probe-sensitive-data',
  'cost-over-norm',
  'stage-remarks',
]);
export type LessonIncidentKind = z.infer<typeof lessonIncidentKindSchema>;

export const lessonIncidentSchema = z.strictObject({
  id: idSchema,
  kind: lessonIncidentKindSchema,
  at: timestampSchema,
  summary: z.string().min(1).max(lessonLimits.incidentSummary),
  details: z
    .array(z.string().min(1).max(lessonLimits.incidentDetail))
    .max(lessonLimits.incidentDetails),
  sessionId: idSchema.nullable(),
  runId: idSchema.nullable(),
  workflowRunId: idSchema.nullable(),
  workflowStepId: idSchema.nullable(),
  workflow: z.string().max(200).nullable(),
  directory: z.string().max(lessonLimits.scopeValue).nullable(),
  proposedAt: timestampSchema.nullable(),
});
export type LessonIncident = z.infer<typeof lessonIncidentSchema>;

export const lessonRoleSchema = z.enum([
  'standalone',
  'orchestrator',
  'worker',
  'workflow-agent',
  'reviewer',
]);
export type LessonRole = z.infer<typeof lessonRoleSchema>;

const absolutePathPattern = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

export const lessonScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({
    kind: z.literal('repository'),
    value: z.union([
      githubRepositorySchema,
      singleLineSchema(lessonLimits.scopeValue).regex(
        absolutePathPattern,
        'Use an absolute project folder or a GitHub owner/name.',
      ),
    ]),
  }),
  z.strictObject({ kind: z.literal('role'), value: lessonRoleSchema }),
  z.strictObject({
    kind: z.literal('workflow'),
    value: singleLineSchema(200),
  }),
]);
export type LessonScope = z.infer<typeof lessonScopeSchema>;

export const lessonEvidenceSchema = z.strictObject({
  incidentId: idSchema,
  kind: lessonIncidentKindSchema,
  summary: z.string().min(1).max(lessonLimits.incidentSummary),
  at: timestampSchema,
  sessionId: idSchema.nullable(),
  runId: idSchema.nullable(),
  workflowRunId: idSchema.nullable(),
});
export type LessonEvidence = z.infer<typeof lessonEvidenceSchema>;

export const lessonStatusSchema = z.enum([
  'proposed',
  'approved',
  'rejected',
  'retired',
]);
export type LessonStatus = z.infer<typeof lessonStatusSchema>;

export const lessonLocationSchema = z.strictObject({
  scope: definitionScopeSchema,
  root: z.string().min(1).max(lessonLimits.scopeValue),
  path: z.string().min(1).max(lessonLimits.scopeValue),
  name: stepNameSchema,
  changeId: idSchema.nullable(),
});
export type LessonLocation = z.infer<typeof lessonLocationSchema>;

export const lessonSchema = z.strictObject({
  id: idSchema,
  version: z.string().min(1).max(80),
  status: lessonStatusSchema,
  location: lessonLocationSchema.nullable(),
  title: singleLineSchema(lessonLimits.title),
  rule: textSchema(lessonLimits.rule),
  scope: lessonScopeSchema,
  evidence: z.array(lessonEvidenceSchema).max(lessonLimits.evidence),
  reviewAt: timestampSchema,
  proposalId: idSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
});
export type Lesson = z.infer<typeof lessonSchema>;

const enforceSettingsProvider = (
  value: { provider: string; model: string },
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
};

export const lessonSettingsSchema = z
  .strictObject({
    dailyProposals: z.boolean(),
    provider: providerSchema,
    model: z.string().trim().min(1).max(200),
    costNormUsd: z.number().positive().max(10_000).nullable(),
  })
  .superRefine(enforceSettingsProvider);
export type LessonSettings = z.infer<typeof lessonSettingsSchema>;

export const defaultLessonSettings: LessonSettings = {
  dailyProposals: false,
  provider: 'Claude Code',
  model: 'haiku',
  costNormUsd: 5,
};

export const lessonProposalStateSchema = z.strictObject({
  status: z.enum(['idle', 'running', 'failed', 'invalid']),
  proposalId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
  proposed: z.number().int().nonnegative(),
  error: z.string().max(lessonLimits.error).nullable(),
});
export type LessonProposalState = z.infer<typeof lessonProposalStateSchema>;

export const lessonOverviewSchema = z.strictObject({
  settings: lessonSettingsSchema,
  proposal: lessonProposalStateSchema,
  nextProposalAt: timestampSchema.nullable(),
  lessons: z
    .array(lessonSchema)
    .max(
      lessonLimits.proposals +
        lessonLimits.lessonsPerRoot * lessonLimits.lessonRoots,
    ),
  issues: z.array(z.string().min(1).max(lessonLimits.error)).max(50),
  incidents: z.array(lessonIncidentSchema).max(lessonLimits.listedIncidents),
  pendingIncidents: z.number().int().nonnegative(),
});
export type LessonOverview = z.infer<typeof lessonOverviewSchema>;

export const proposedLessonSchema = z.strictObject({
  title: singleLineSchema(lessonLimits.title),
  rule: textSchema(lessonLimits.rule),
  scope: lessonScopeSchema,
  evidence: z.array(idSchema).min(1).max(lessonLimits.evidence),
  reviewInDays: z
    .number()
    .int()
    .min(lessonLimits.minimumReviewDays)
    .max(lessonLimits.maximumReviewDays),
});
export type ProposedLesson = z.infer<typeof proposedLessonSchema>;

export const lessonProposalOutputSchema = z.strictObject({
  lessons: z.array(proposedLessonSchema).max(lessonLimits.proposedLessons),
});
export type LessonProposalOutput = z.infer<typeof lessonProposalOutputSchema>;

export const lessonProposalOutputJsonSchema = () =>
  z.toJSONSchema(lessonProposalOutputSchema, { io: 'input' });

export const proposeLessonsSchema = z.strictObject({ requestId: idSchema });
export type ProposeLessonsInput = z.infer<typeof proposeLessonsSchema>;

export const decideLessonSchema = z.strictObject({
  lessonId: idSchema,
  expectedVersion: z.string().min(1).max(80),
  decision: z.enum(['approve', 'edit', 'reject', 'retire', 'undo']),
  title: singleLineSchema(lessonLimits.title).optional(),
  rule: textSchema(lessonLimits.rule).optional(),
  scope: lessonScopeSchema.optional(),
  reviewAt: timestampSchema.optional(),
});
export type DecideLessonInput = z.infer<typeof decideLessonSchema>;

export const lessonIsDue = (lesson: Lesson, now: Date): boolean =>
  lesson.status === 'approved' && Date.parse(lesson.reviewAt) <= now.getTime();

export const lessonNeedsDecision = (lesson: Lesson, now: Date): boolean =>
  lesson.status === 'proposed' || lessonIsDue(lesson, now);
