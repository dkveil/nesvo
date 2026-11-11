import { z } from 'zod';
import { claudeModelSchema } from '../sessions';
import {
  SCHEDULE_TIME_PATTERN,
  SCHEDULED_JOB_MAX_INTERVAL_MINUTES,
  SCHEDULED_JOB_MIN_INTERVAL_MINUTES,
  canonicalizeTimeZone,
  isValidTimeZone,
} from './schedule';

export {
  SCHEDULE_TIME_PATTERN,
  SCHEDULED_JOB_MAX_INTERVAL_MINUTES,
  SCHEDULED_JOB_MIN_INTERVAL_MINUTES,
  ScheduleError,
  assertValidSchedule,
  canonicalizeTimeZone,
  collapseMissed,
  describeSchedule,
  isValidTimeZone,
  nextOccurrence,
  previewOccurrences,
  type MissedOccurrences,
  type ScheduleErrorCode,
  type ScheduleRule,
} from './schedule';

export const scheduledJobLimits = {
  name: 80,
  prompt: 8000,
  directory: 4096,
  model: 200,
  effort: 50,
  jobs: 200,
  runPage: 100,
  cursor: 512,
  minTimeoutMinutes: 5,
  maxTimeoutMinutes: 120,
  defaultTimeoutMinutes: 30,
} as const;

const timeSchema = z.string().regex(SCHEDULE_TIME_PATTERN);

export const scheduledJobScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('daily'), time: timeSchema }),
  z.strictObject({ kind: z.literal('weekdays'), time: timeSchema }),
  z.strictObject({
    kind: z.literal('weekly'),
    weekday: z.number().int().min(0).max(6),
    time: timeSchema,
  }),
  z.strictObject({
    kind: z.literal('interval'),
    minutes: z
      .number()
      .int()
      .min(SCHEDULED_JOB_MIN_INTERVAL_MINUTES)
      .max(SCHEDULED_JOB_MAX_INTERVAL_MINUTES),
    anchorAt: z.iso.datetime(),
  }),
]);

export const scheduledJobProviderSchema = z.enum(['claude', 'codex']);
export const scheduledJobModeSchema = z.literal('read-only');
export const scheduledJobTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimeZone, 'Use an IANA time zone such as Europe/Warsaw.')
  .transform(canonicalizeTimeZone);

const scheduledJobDefinitionShape = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(scheduledJobLimits.name)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(scheduledJobLimits.prompt)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/),
  directory: z.string().trim().max(scheduledJobLimits.directory),
  provider: scheduledJobProviderSchema,
  model: z.string().trim().min(1).max(scheduledJobLimits.model),
  effort: z.string().trim().min(1).max(scheduledJobLimits.effort).nullable(),
  mode: scheduledJobModeSchema,
  schedule: scheduledJobScheduleSchema,
  timeZone: scheduledJobTimeZoneSchema,
  active: z.boolean(),
  timeoutMinutes: z
    .number()
    .int()
    .min(scheduledJobLimits.minTimeoutMinutes)
    .max(scheduledJobLimits.maxTimeoutMinutes)
    .default(scheduledJobLimits.defaultTimeoutMinutes),
};

type ProviderRuleSubject = {
  provider: z.infer<typeof scheduledJobProviderSchema>;
  model: string;
  effort: string | null;
};

const enforceProviderRules = (
  value: ProviderRuleSubject,
  context: z.RefinementCtx,
) => {
  if (value.provider !== 'claude') return;
  if (!claudeModelSchema.safeParse(value.model).success)
    context.addIssue({
      code: 'custom',
      path: ['model'],
      message: 'Unsupported Claude Code model',
    });
  if (value.effort !== null)
    context.addIssue({
      code: 'custom',
      path: ['effort'],
      message: 'Effort applies to Codex only',
    });
};

const idSchema = z.uuid();
const revisionSchema = z.number().int().positive();

export const scheduledJobDefinitionSchema = z
  .strictObject(scheduledJobDefinitionShape)
  .superRefine(enforceProviderRules);

export const scheduledJobSchema = z
  .strictObject({
    id: idSchema,
    revision: revisionSchema,
    ...scheduledJobDefinitionShape,
    nextRunAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine(enforceProviderRules);

export const scheduledJobRunStatusSchema = z.enum([
  'starting',
  'running',
  'completed',
  'failed',
  'stopped',
  'interrupted',
  'skipped',
  'unavailable',
]);
export const scheduledJobRunReasonSchema = z.enum([
  'missed',
  'overlap',
  'busy',
  'limit',
  'folder',
  'catalog',
  'timeout',
  'restart',
]);

export const scheduledJobRunSchema = z
  .strictObject({
    id: idSchema,
    scheduledJobId: idSchema,
    scheduledFor: z.iso.datetime().nullable(),
    trigger: z.enum(['schedule', 'manual']),
    status: scheduledJobRunStatusSchema,
    reason: scheduledJobRunReasonSchema.nullable(),
    missedCount: z.number().int().min(0),
    sessionId: idSchema.nullable(),
    runId: idSchema.nullable(),
    reviewId: idSchema.nullable(),
    resetAt: z.iso.datetime().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .superRefine((value, context) => {
    if ((value.trigger === 'manual') !== (value.scheduledFor === null))
      context.addIssue({
        code: 'custom',
        path: ['scheduledFor'],
        message: 'Only manual runs omit the scheduled time',
      });
  });

export const listScheduledJobsSchema = z.strictObject({});

export const saveScheduledJobSchema = z
  .strictObject({
    id: idSchema,
    expectedRevision: revisionSchema.nullable(),
    ...scheduledJobDefinitionShape,
  })
  .superRefine(enforceProviderRules);

export const setScheduledJobActiveSchema = z.strictObject({
  id: idSchema,
  expectedRevision: revisionSchema,
  active: z.boolean(),
});

export const deleteScheduledJobSchema = z.strictObject({
  id: idSchema,
  expectedRevision: revisionSchema,
});

export const runScheduledJobNowSchema = z.strictObject({
  id: idSchema,
  requestId: idSchema,
});

export const listScheduledJobRunsSchema = z.strictObject({
  scheduledJobId: idSchema,
  cursor: z
    .string()
    .min(1)
    .max(scheduledJobLimits.cursor)
    .nullable()
    .default(null),
  limit: z.number().int().min(1).max(scheduledJobLimits.runPage).default(20),
});

export const scheduledJobListSchema = z.strictObject({
  scheduledJobs: z.array(scheduledJobSchema).max(scheduledJobLimits.jobs),
});

export const scheduledJobRunPageSchema = z.strictObject({
  runs: z.array(scheduledJobRunSchema).max(scheduledJobLimits.runPage),
  nextCursor: z.string().min(1).max(scheduledJobLimits.cursor).nullable(),
});

export const scheduledJobSessionOriginSchema = z.strictObject({
  kind: z.literal('scheduled-job'),
  scheduledJobId: idSchema,
  runId: idSchema,
});

export type ScheduledJobSchedule = z.infer<typeof scheduledJobScheduleSchema>;
export type ScheduledJobDefinition = z.infer<
  typeof scheduledJobDefinitionSchema
>;
export type ScheduledJob = z.infer<typeof scheduledJobSchema>;
export type ScheduledJobRun = z.infer<typeof scheduledJobRunSchema>;
export type ScheduledJobRunStatus = z.infer<typeof scheduledJobRunStatusSchema>;
export type ScheduledJobRunReason = z.infer<typeof scheduledJobRunReasonSchema>;
export type ListScheduledJobsInput = z.infer<typeof listScheduledJobsSchema>;
export type SaveScheduledJobInput = z.input<typeof saveScheduledJobSchema>;
export type SetScheduledJobActiveInput = z.infer<
  typeof setScheduledJobActiveSchema
>;
export type DeleteScheduledJobInput = z.infer<typeof deleteScheduledJobSchema>;
export type RunScheduledJobNowInput = z.infer<typeof runScheduledJobNowSchema>;
export type ListScheduledJobRunsInput = z.input<
  typeof listScheduledJobRunsSchema
>;
export type ScheduledJobList = z.infer<typeof scheduledJobListSchema>;
export type ScheduledJobRunPage = z.infer<typeof scheduledJobRunPageSchema>;
export type ScheduledJobSessionOrigin = z.infer<
  typeof scheduledJobSessionOriginSchema
>;
