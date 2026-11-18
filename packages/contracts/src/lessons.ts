import { z } from 'zod';
import {
  ruleEntryBodySchema,
  ruleEntryDescriptionSchema,
  ruleEntryEnforcedBySchema,
  ruleEntryFieldsSchema,
  ruleEntryMetricsSchema,
  ruleEntryProvenanceSchema,
  ruleEntryScopeSchema,
  type RuleEntryRole,
} from './rule-entries';
import { claudeModelSchema, providerSchema } from './sessions';
import { definitionScopeSchema } from './workflows/definitions';

export const lessonLimits = {
  incidents: 500,
  listedIncidents: 100,
  incidentSummary: 500,
  incidentDetail: 400,
  incidentDetails: 6,
  proposalIncidents: 60,
  proposedLessons: 10,
  proposals: 100,
  listedLessons: 2000,
  lessonRoots: 100,
  path: 4096,
  evidence: 10,
  error: 2000,
  minimumReviewDays: 1,
  maximumReviewDays: 365,
  defaultReviewDays: 30,
  unusedDays: 60,
} as const;

export const LESSON_PROPOSAL_INTERVAL_MS = 24 * 60 * 60_000;
export const OWNER_LESSONS_HEADING = 'Owner lessons';

const idSchema = z.uuid();
const timestampSchema = z.iso.datetime();
const absolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(lessonLimits.path)
  .regex(
    /^(?:\/(?!\/)|[A-Za-z]:[\\/])[^\u0000-\u001f\u007f]*$/,
    'Use an absolute project folder.',
  );

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
  quote: z.string().min(1).max(400).nullable().default(null),
  sessionId: idSchema.nullable(),
  runId: idSchema.nullable(),
  workflowRunId: idSchema.nullable(),
  workflowStepId: idSchema.nullable(),
  workflow: z.string().max(200).nullable(),
  step: z.string().max(200).nullable().default(null),
  directory: z.string().max(lessonLimits.path).nullable(),
  proposedAt: timestampSchema.nullable(),
});
export type LessonIncident = z.infer<typeof lessonIncidentSchema>;

export type LessonRole = RuleEntryRole;

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

export const lessonStateSchema = z.enum(['proposed', 'active', 'retired']);
export type LessonState = z.infer<typeof lessonStateSchema>;

export const lessonLocationSchema = z.strictObject({
  scope: definitionScopeSchema,
  root: z.string().min(1).max(lessonLimits.path),
  path: z.string().min(1).max(lessonLimits.path),
  changeId: idSchema.nullable(),
  trusted: z.boolean(),
});
export type LessonLocation = z.infer<typeof lessonLocationSchema>;

export const lessonMetricsSchema = ruleEntryMetricsSchema;
export type LessonMetrics = z.infer<typeof lessonMetricsSchema>;

export const lessonSchema = z.strictObject({
  key: z.string().min(1).max(80),
  id: z.string().min(1).max(40).nullable(),
  state: lessonStateSchema,
  description: ruleEntryDescriptionSchema,
  kind: ruleEntryFieldsSchema.shape.kind,
  scope: ruleEntryScopeSchema,
  enforcedBy: ruleEntryEnforcedBySchema,
  review: z.iso.date().nullable(),
  provenance: ruleEntryProvenanceSchema,
  body: ruleEntryBodySchema,
  project: absolutePathSchema.nullable(),
  version: z.string().min(1).max(80),
  location: lessonLocationSchema.nullable(),
  evidence: z.array(lessonEvidenceSchema).max(lessonLimits.evidence),
  metrics: lessonMetricsSchema.nullable(),
  createdAt: timestampSchema,
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
  dropped: z.number().int().nonnegative().default(0),
  error: z.string().max(lessonLimits.error).nullable(),
});
export type LessonProposalState = z.infer<typeof lessonProposalStateSchema>;

export const lessonOverviewSchema = z.strictObject({
  settings: lessonSettingsSchema,
  proposal: lessonProposalStateSchema,
  nextProposalAt: timestampSchema.nullable(),
  lessons: z.array(lessonSchema).max(lessonLimits.listedLessons),
  issues: z.array(z.string().min(1).max(lessonLimits.error)).max(50),
  incidents: z.array(lessonIncidentSchema).max(lessonLimits.listedIncidents),
  pendingIncidents: z.number().int().nonnegative(),
});
export type LessonOverview = z.infer<typeof lessonOverviewSchema>;

export const proposedLessonSchema = z.strictObject({
  description: ruleEntryDescriptionSchema,
  kind: ruleEntryFieldsSchema.shape.kind,
  rule: z.string().trim().min(1),
  why: z.string().trim().min(1),
  check: z.string().trim().min(1),
  scope: ruleEntryScopeSchema,
  project: absolutePathSchema.nullable(),
  enforcedBy: ruleEntryEnforcedBySchema,
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

export const lessonChangesSchema = z.strictObject({
  description: ruleEntryDescriptionSchema.optional(),
  kind: ruleEntryFieldsSchema.shape.kind.optional(),
  body: ruleEntryBodySchema.optional(),
  scope: ruleEntryScopeSchema.optional(),
  enforcedBy: ruleEntryEnforcedBySchema.optional(),
  review: z.iso.date().optional(),
  project: absolutePathSchema.nullable().optional(),
});
export type LessonChanges = z.infer<typeof lessonChangesSchema>;

export const decideLessonSchema = z.strictObject({
  key: z.string().min(1).max(80),
  expectedVersion: z.string().min(1).max(80),
  decision: z.enum(['approve', 'edit', 'reject', 'retire', 'undo']),
  changes: lessonChangesSchema.optional(),
});
export type DecideLessonInput = z.infer<typeof decideLessonSchema>;

export const lessonIsDue = (lesson: Lesson, today: string): boolean =>
  lesson.state === 'active' && !!lesson.review && lesson.review <= today;

export const lessonNeedsDecision = (lesson: Lesson, today: string): boolean =>
  lesson.state === 'proposed' || lessonIsDue(lesson, today);
