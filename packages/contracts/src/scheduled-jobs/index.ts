import { z } from 'zod';
import { promptSkillSchema } from '../skills';
import { stepNameSchema } from '../workflows/definitions';
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
  defaultDailyRunCap: 3,
  maxDailyRunCap: 24,
  checkTimeoutMs: 10_000,
  checkOutputBytes: 64 * 1024,
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
export const scheduledJobModeSchema = z.enum([
  'read-only',
  'accept-edits',
  'supervised',
]);
export const scheduledJobTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimeZone, 'Use an IANA time zone such as Europe/Warsaw.')
  .transform(canonicalizeTimeZone);

export const scheduledJobWorkflowSchema = z.strictObject({
  name: stepNameSchema,
  specPath: z.string().min(1).max(scheduledJobLimits.directory),
});

export const scheduledJobChangeTriggerSchema = z.strictObject({
  argv: z
    .tuple([
      z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .regex(/^[^\u0000-\u001f\u007f]+$/),
    ])
    .rest(
      z
        .string()
        .max(4096)
        .regex(/^[^\u0000]*$/),
    )
    .refine(
      argv => argv.length <= 32 && argv.join('\u0000').length <= 8192,
      'Use up to 32 arguments and 8,192 characters in total.',
    ),
  dailyRunCap: z
    .number()
    .int()
    .min(1)
    .max(scheduledJobLimits.maxDailyRunCap)
    .default(scheduledJobLimits.defaultDailyRunCap),
  askFirst: z.boolean().default(true),
});

export const scheduledJobPullRequestReviewSchema = z.strictObject({
  profileId: z.uuid(),
});

const scheduledJobRedCiSchema = z.strictObject({
  dailyRunCap: scheduledJobChangeTriggerSchema.shape.dailyRunCap,
});

export const scheduledJobReportSchema = z.string().max(4000);
const scheduledJobChangesSchema = z.strictObject({
  added: z.array(z.string().max(200)).max(20),
  resolved: z.array(z.string().max(200)).max(20),
  summaryChanged: z.boolean(),
});

const scheduledJobCheckSchema = z.strictObject({
  at: z.iso.datetime(),
  status: z.enum(['changed', 'unchanged', 'failed']),
  detail: z.string().max(160).optional(),
});

const scheduledJobPendingStartSchema = z.strictObject({
  id: z.uuid(),
  at: z.iso.datetime(),
  scheduledFor: z.iso.datetime(),
  missedCount: z.number().int().min(0),
});

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
    .max(scheduledJobLimits.prompt)
    .regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/),
  promptSkill: promptSkillSchema.optional(),
  directory: z.string().trim().max(scheduledJobLimits.directory),
  provider: scheduledJobProviderSchema,
  model: z.string().trim().min(1).max(scheduledJobLimits.model),
  effort: z.string().trim().min(1).max(scheduledJobLimits.effort).nullable(),
  mode: scheduledJobModeSchema.default('read-only'),
  schedule: scheduledJobScheduleSchema,
  timeZone: scheduledJobTimeZoneSchema.default(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  ),
  active: z.boolean(),
  timeoutMinutes: z
    .number()
    .int()
    .min(scheduledJobLimits.minTimeoutMinutes)
    .max(scheduledJobLimits.maxTimeoutMinutes)
    .default(scheduledJobLimits.defaultTimeoutMinutes),
  workflow: scheduledJobWorkflowSchema.nullable().default(null),
  changeTrigger: scheduledJobChangeTriggerSchema.optional(),
  pullRequestReview: scheduledJobPullRequestReviewSchema.optional(),
  browser: z.literal(true).optional(),
  redCi: scheduledJobRedCiSchema.optional(),
};

const enforceRitualRules = (
  value: z.infer<z.ZodObject<typeof scheduledJobDefinitionShape>>,
  context: z.RefinementCtx,
) => {
  const issue = (field: string, message: string) =>
    context.addIssue({ code: 'custom', path: [field], message });
  if (
    value.promptSkill &&
    (value.pullRequestReview || (value.workflow && !value.browser))
  )
    issue('promptSkill', 'Choose a skill for a prompt that starts a session.');
  if (value.mode !== 'read-only') {
    if (
      value.mode !==
      (value.provider === 'claude' ? 'accept-edits' : 'supervised')
    )
      issue('mode', 'Choose an access mode for the selected provider.');
    if (value.workflow || value.pullRequestReview)
      issue('mode', 'Writable automations run a session prompt.');
    if (!value.directory && !value.redCi && value.active)
      issue('directory', 'Choose a repository checkout for the worktree.');
  }
  if (
    value.browser &&
    (value.pullRequestReview || (value.active && !value.workflow))
  )
    issue(
      'browser',
      'Browser access requires a workflow from your global workflows folder.',
    );
  if (
    value.redCi &&
    (value.mode === 'read-only' ||
      value.changeTrigger ||
      value.workflow ||
      value.pullRequestReview ||
      value.browser)
  )
    issue(
      'redCi',
      'Red CI requires a writable session prompt without another trigger.',
    );
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

const enforcePromptRule = (
  value: { prompt: string; workflow: unknown; pullRequestReview?: unknown },
  context: z.RefinementCtx,
) => {
  if (value.prompt === '' && !value.workflow && !value.pullRequestReview)
    context.addIssue({
      code: 'custom',
      path: ['prompt'],
      message: 'Enter a prompt.',
    });
  if (value.workflow && value.pullRequestReview)
    context.addIssue({
      code: 'custom',
      path: ['pullRequestReview'],
      message: 'An automation runs either a workflow or pull request reviews.',
    });
};

const enforceReviewFolder = (
  value: { pullRequestReview?: unknown; directory: string },
  context: z.RefinementCtx,
) => {
  if (value.pullRequestReview && !value.directory)
    context.addIssue({
      code: 'custom',
      path: ['directory'],
      message: 'Choose a checkout of the repository to review.',
    });
};

const enforceTriggerFolder = (
  value: { changeTrigger?: unknown; directory: string },
  context: z.RefinementCtx,
) => {
  if (value.changeTrigger && !value.directory)
    context.addIssue({
      code: 'custom',
      path: ['directory'],
      message: 'Choose a folder for the check command.',
    });
};

const idSchema = z.uuid();
const revisionSchema = z.number().int().positive();

export const scheduledJobDefinitionSchema = z
  .strictObject(scheduledJobDefinitionShape)
  .superRefine(enforceProviderRules)
  .superRefine(enforcePromptRule)
  .superRefine(enforceTriggerFolder)
  .superRefine(enforceReviewFolder)
  .superRefine(enforceRitualRules);

export const scheduledJobSchema = z
  .strictObject({
    id: idSchema,
    revision: revisionSchema,
    ...scheduledJobDefinitionShape,
    lastCheck: scheduledJobCheckSchema.optional(),
    pendingStart: scheduledJobPendingStartSchema.optional(),
    nextRunAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine(enforceProviderRules)
  .superRefine(enforcePromptRule)
  .superRefine(enforceTriggerFolder)
  .superRefine(enforceReviewFolder)
  .superRefine(enforceRitualRules);

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
    workflowRunId: idSchema.nullable().default(null),
    reviewId: idSchema.nullable(),
    resetAt: z.iso.datetime().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    detail: z.string().max(400).optional(),
    report: scheduledJobReportSchema.optional(),
    changes: scheduledJobChangesSchema.optional(),
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
  .superRefine(enforceProviderRules)
  .superRefine(enforcePromptRule)
  .superRefine(enforceTriggerFolder)
  .superRefine(enforceReviewFolder)
  .superRefine(enforceRitualRules);

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

export const decideScheduledJobStartSchema = z.strictObject({
  id: idSchema,
  pendingId: idSchema,
  decision: z.enum(['start', 'skip']),
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

export type ScheduledJobWorkflow = z.infer<typeof scheduledJobWorkflowSchema>;
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
export type DecideScheduledJobStartInput = z.infer<
  typeof decideScheduledJobStartSchema
>;
export type ListScheduledJobRunsInput = z.input<
  typeof listScheduledJobRunsSchema
>;
export type ScheduledJobList = z.infer<typeof scheduledJobListSchema>;
export type ScheduledJobRunPage = z.infer<typeof scheduledJobRunPageSchema>;
export type ScheduledJobSessionOrigin = z.infer<
  typeof scheduledJobSessionOriginSchema
>;
