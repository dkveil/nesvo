import {
  attachWorktreeSchema,
  sessionWorktreeBindingSchema,
  worktreeTaskFieldsSchema,
} from './worktree-providers';
import { z } from 'zod';
import {
  allowPatternSchema,
  allowRuleSchema,
  allowRuleTextSchema,
  allowScopeSchema,
} from './claude-autonomy';
import { pullRequestReferenceSchema } from './pull-requests';
import { decisionRouteSchema } from './decision-route';
import { activityLimits, sessionActivitySchema } from './activities';
import {
  effortSupportSchema,
  modelEffortsSchema,
  reasoningEffortOptionSchema,
  reasoningEffortSchema,
} from './reasoning-effort';
import { skillHashSchema, skillReferenceSchema } from './skills';
import {
  mcpSelectionSchema,
  messageMcpSchema,
  sessionMcpSchema,
} from './mcp-selection';
import {
  imageInputSupportSchema,
  messageAttachmentsSchema,
} from './attachments';
import { messageCodeCommentsSchema } from './code-comments';
import {
  stageLimits,
  stageQuestionSchema,
  stageReportSchema,
} from './stage-report';

export const browserSupportSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('supported') }),
  z.strictObject({
    status: z.literal('unsupported'),
    reason: z.string().min(1).max(500),
  }),
]);
export const claudeModelSchema = z.enum(['default', 'opus', 'sonnet', 'haiku']);
export const providerSchema = z.enum(['Claude Code', 'Codex']);
export const sessionModeSchema = z.enum([
  'read-only',
  'supervised',
  'accept-edits',
  'auto',
  'full-access',
]);
export const providerSessionModes = {
  'Claude Code': ['read-only', 'accept-edits', 'auto'],
  Codex: ['read-only', 'supervised'],
} as const satisfies Record<
  z.infer<typeof providerSchema>,
  readonly z.infer<typeof sessionModeSchema>[]
>;
export const isProviderSessionMode = (
  provider: z.infer<typeof providerSchema>,
  mode: z.infer<typeof sessionModeSchema>,
): boolean =>
  (providerSessionModes[provider] as readonly string[]).includes(mode);
export const isWritableSessionMode = (
  mode: z.infer<typeof sessionModeSchema>,
): boolean => mode !== 'read-only';
export const sessionWorkflowSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  root: z.enum(['project', 'global']),
});
const modelSchema = z.string().trim().min(1).max(200);
export const workerProposalSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(100),
    task: z.string().trim().min(1).max(8000),
    scope: z.string().trim().min(1).max(1000),
    directory: z.string().trim().min(1).max(4096),
    provider: providerSchema,
    model: modelSchema,
    mode: sessionModeSchema,
    planFirst: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (
      !isProviderSessionMode(value.provider, value.mode) ||
      (value.provider === 'Claude Code' &&
        !claudeModelSchema.safeParse(value.model).success)
    )
      context.addIssue({
        code: 'custom',
        message: `Unsupported ${value.provider} worker configuration`,
      });
  });
export const coordinatorGroupCap = 8;
export const delegationPlanSchema = z.strictObject({
  workers: z
    .array(workerProposalSchema)
    .min(1)
    .max(coordinatorGroupCap - 1),
});
export const delegationSchema = workerProposalSchema.safeExtend({
  id: z.uuid(),
  runId: z.uuid(),
  status: z.enum([
    'pending',
    'declined',
    'planning',
    'plan-ready',
    'running',
    'completed',
    'stopped',
    'failed',
    'interrupted',
  ]),
  childSessionId: z.uuid().nullable(),
  childRunId: z.uuid().nullable().optional(),
  error: z.string().nullable(),
  plan: z.string().max(12000).nullable().default(null),
  planRound: z.number().int().nonnegative().default(0),
});
export const approvalSchema = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(['command', 'file-change', 'tool']),
  title: z.string().min(1).max(500),
  detail: z.string().max(100_000),
  directory: z.string().max(4096).nullable(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  allowPattern: allowPatternSchema.optional(),
  allowRuleReason: z.string().min(1).max(500).optional(),
  label: z.string().min(1).max(8192).optional(),
});
export const sessionParentRequestSchema = z.strictObject({
  id: z.uuid(),
  parentId: z.uuid(),
  parentTitle: z.string().max(100),
  requestedAt: z.iso.datetime(),
});
export type SessionParentRequest = z.infer<typeof sessionParentRequestSchema>;
export const sessionPlanLimits = { text: 12_000, rounds: 5 } as const;
export const stageRecordLimit = 50;
export const stageActorSchema = z.strictObject({
  kind: z.enum(['owner', 'coordinator']),
  via: z.enum(['desktop', 'mobile', 'session-control', 'parent']),
  sessionId: z.uuid().nullable().default(null),
});
export type StageActor = z.infer<typeof stageActorSchema>;
export const sessionPlanSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['planning', 'plan-ready', 'accepted', 'declined']),
  round: z.number().int().nonnegative(),
  targetMode: sessionModeSchema,
  text: z.string().max(sessionPlanLimits.text).nullable(),
  runId: z.uuid().nullable(),
  readyAt: z.iso.datetime().nullable(),
});
export type SessionPlan = z.infer<typeof sessionPlanSchema>;
const recordBaseSchema = z.strictObject({
  id: z.uuid(),
  at: z.iso.datetime(),
});
export const stageAnswerSchema = z.strictObject({
  at: z.iso.datetime(),
  by: stageActorSchema,
  option: z.string().max(stageLimits.optionLabel).nullable(),
  text: z.string().max(stageLimits.answer).nullable(),
  messageId: z.uuid(),
});
export const sessionStageRecordSchema = z.discriminatedUnion('kind', [
  recordBaseSchema.extend({
    kind: z.literal('plan'),
    planId: z.uuid(),
    runId: z.uuid(),
    round: z.number().int().nonnegative(),
    text: z.string().max(sessionPlanLimits.text),
  }),
  recordBaseSchema.extend({
    kind: z.literal('plan-decision'),
    planId: z.uuid(),
    decision: z.enum(['accept', 'correct', 'decline']),
    by: stageActorSchema,
    mode: sessionModeSchema.nullable(),
    text: z.string().max(stageLimits.answer).nullable(),
    messageId: z.uuid().nullable(),
  }),
  recordBaseSchema.extend({
    kind: z.literal('mode-change'),
    from: sessionModeSchema,
    to: sessionModeSchema,
    by: stageActorSchema,
  }),
  recordBaseSchema.extend({
    kind: z.literal('allow-rule'),
    rule: allowRuleSchema,
  }),
  recordBaseSchema.extend({
    kind: z.literal('report'),
    runId: z.uuid(),
    source: z.enum(['tool', 'answer']),
    report: stageReportSchema,
  }),
  recordBaseSchema.extend({
    kind: z.literal('report-invalid'),
    runId: z.uuid(),
    source: z.enum(['tool', 'answer']),
    error: z.string().max(stageLimits.error),
  }),
  recordBaseSchema.extend({
    kind: z.literal('question'),
    runId: z.uuid(),
    question: stageQuestionSchema,
    status: z.enum(['pending', 'answered']),
    answer: stageAnswerSchema.nullable(),
  }),
  recordBaseSchema.extend({
    kind: z.literal('progress'),
    runId: z.uuid(),
    text: z.string().max(stageLimits.progress),
  }),
  recordBaseSchema.extend({
    kind: z.literal('decision'),
    subject: z.enum(['rule', 'plan', 'question', 'approval']),
    itemId: z.string().min(1).max(200),
    childId: z.uuid().nullable(),
    childTitle: z.string().max(200).nullable(),
    title: z.string().max(500),
    route: decisionRouteSchema,
    status: z.enum(['needed', 'decided']),
    outcome: z.string().max(stageLimits.answer).nullable(),
    by: stageActorSchema.nullable(),
  }),
]);
export type SessionStageRecord = z.infer<typeof sessionStageRecordSchema>;
export type StageQuestionRecord = Extract<
  SessionStageRecord,
  { kind: 'question' }
>;
export type StageReportRecord = Extract<SessionStageRecord, { kind: 'report' }>;
export const pendingStageQuestion = (
  session: Pick<Session, 'stageRecords'>,
): StageQuestionRecord | undefined =>
  session.stageRecords.findLast(
    (record): record is StageQuestionRecord =>
      record.kind === 'question' && record.status === 'pending',
  );
export const latestStageReport = (
  session: Pick<Session, 'stageRecords'>,
): StageReportRecord | undefined =>
  session.stageRecords.findLast(
    (record): record is StageReportRecord => record.kind === 'report',
  );
export const sessionStateSchema = z.enum([
  'ready',
  'running',
  'stopping',
  'completed',
  'stopped',
  'failed',
  'interrupted',
]);
export const sessionInterruptionSchema = z.strictObject({
  runId: z.uuid(),
  reason: z.enum(['host-shutdown', 'host-restart', 'provider-disconnected']),
  at: z.iso.datetime(),
});
export type SessionInterruption = z.infer<typeof sessionInterruptionSchema>;
export const SESSION_BRANCH_PATTERN =
  /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])(?<!\.lock)$/;
export const sessionIsolationSchema = z.strictObject({
  kind: z.literal('worktree'),
  branch: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(SESSION_BRANCH_PATTERN, 'Use a valid Git branch name.')
    .optional(),
  task: worktreeTaskFieldsSchema.optional(),
  attach: attachWorktreeSchema.optional(),
  providerRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const sessionWorktreeSchema = z.strictObject({
  projectDirectory: z.string().min(1).max(4096),
  branch: z.string().min(1).max(200).regex(SESSION_BRANCH_PATTERN),
  base: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  state: z.enum(['active', 'kept', 'removed']),
  binding: sessionWorktreeBindingSchema.optional(),
  workerTargetBranch: z.string().min(1).max(1024).optional(),
  workerResolution: z.enum(['merge', 'discard']).optional(),
  includes: z
    .strictObject({
      copied: z.number().int().nonnegative().max(64),
      skipped: z.number().int().nonnegative(),
      incomplete: z.boolean(),
    })
    .optional(),
});
export const readSessionWorktreeSchema = z.strictObject({
  sessionId: z.uuid(),
});
export const sessionWorktreeStatusSchema = z.strictObject({
  dirty: z.boolean(),
});
export const finishSessionWorktreeSchema = readSessionWorktreeSchema.extend({
  action: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('keep') }),
    z.strictObject({ kind: z.literal('pull-request') }),
    z.strictObject({
      kind: z.literal('remove'),
      force: z.boolean().default(false),
    }),
  ]),
});
const setupHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const runSessionWorktreeSetupSchema = readSessionWorktreeSchema.extend({
  sha256: setupHashSchema,
  approve: z.boolean().default(false),
});
export const sessionWorktreeSetupResultSchema = z.strictObject({
  sha256: setupHashSchema,
  status: z.enum(['completed', 'failed', 'timed-out']),
  exitCode: z.number().int().nullable(),
  stdout: z.string().max(16 * 1024),
  stderr: z.string().max(16 * 1024),
  truncated: z.boolean(),
});
export const sessionWorktreeSetupSchema = z.strictObject({
  script: z
    .strictObject({ sha256: setupHashSchema, approved: z.boolean() })
    .nullable(),
  result: sessionWorktreeSetupResultSchema.nullable(),
});
export const orphanedSessionWorktreesSchema = z
  .array(
    z.strictObject({
      id: z.uuid(),
      directory: z.string().min(1).max(4096),
      branch: z.string().min(1).max(200),
      sessionTitle: z.string().min(1).max(100).nullable(),
    }),
  )
  .max(100);
export const removeOrphanedSessionWorktreeSchema = z.strictObject({
  id: z.uuid(),
  force: z.boolean().default(false),
});
export const orphanedSessionWorktreeRemovalSchema = z.enum([
  'removed',
  'dirty',
]);
export const createSessionSchema = z
  .strictObject({
    requestId: z.uuid().toLowerCase().optional(),
    title: z.string().trim().min(1).max(100),
    provider: providerSchema.default('Claude Code'),
    profileId: z.uuid().nullable().optional(),
    model: modelSchema,
    mode: sessionModeSchema.default('read-only'),
    role: z.enum(['orchestrator', 'standalone']).optional(),
    directory: z.string().trim().max(4096).optional(),
    effort: reasoningEffortSchema.optional(),
    isolation: sessionIsolationSchema.optional(),
    groupId: z.uuid().optional(),
    mcp: mcpSelectionSchema.optional(),
    planFirst: z.boolean().optional(),
    browser: z.boolean().optional(),
    reviewEveryResult: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (
      !isProviderSessionMode(value.provider, value.mode) ||
      (value.provider === 'Claude Code' &&
        !claudeModelSchema.safeParse(value.model).success)
    )
      context.addIssue({
        code: 'custom',
        message: `Unsupported ${value.provider} model or mode`,
      });
    if (value.effort && value.provider === 'Codex' && value.model === 'default')
      context.addIssue({
        code: 'custom',
        path: ['effort'],
        message: 'Choose a specific Codex model to set a reasoning effort',
      });
  });
export const sendMessageSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  replyToRunId: z.uuid().optional(),
  text: z.string().trim().min(1).max(32000),
  skillId: z.string().min(1).max(8192).optional(),
  skillHash: skillHashSchema.optional(),
  model: modelSchema.optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  mode: sessionModeSchema.optional(),
  attachments: messageAttachmentsSchema.optional(),
  codeComments: messageCodeCommentsSchema.optional(),
});
export const assignSessionWorkflowSchema = z
  .strictObject({
    sessionId: z.uuid(),
    workflow: sessionWorkflowSchema.nullable().optional(),
    reviewEveryResult: z.boolean().optional(),
  })
  .refine(
    input =>
      input.workflow !== undefined || input.reviewEveryResult !== undefined,
    'Choose a session setting to update.',
  );
export const forkSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  profileId: z.uuid().nullable().optional(),
  worktree: z
    .strictObject({ carryChanges: z.boolean().default(false) })
    .optional(),
});
export const restartSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  profileId: z.uuid().nullable().optional(),
  revision: z.number().int().nonnegative(),
});
export const compactInstructionsMaxLength = 4000;
export const compactSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  revision: z.number().int().nonnegative(),
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(compactInstructionsMaxLength)
    .optional(),
});
export const queuedMessageSchema = z.strictObject({
  id: z.uuid(),
  text: z.string().trim().min(1).max(32000),
  skillId: z.string().min(1).max(8192).optional(),
  skillHash: skillHashSchema.optional(),
  model: modelSchema.optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  mode: sessionModeSchema.optional(),
  attachments: messageAttachmentsSchema.optional(),
  codeComments: messageCodeCommentsSchema.optional(),
  createdAt: z.iso.datetime(),
  held: z.boolean().default(false),
});
export const queuedMessageRefSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
});
export const sessionQueueLimit = 20;
export const stopRunSchema = z.strictObject({
  sessionId: z.uuid(),
  runId: z.uuid(),
});
export const respondApprovalSchema = z.strictObject({
  sessionId: z.uuid(),
  runId: z.uuid(),
  requestId: z.string().min(1).max(200),
  decision: z.enum(['accept', 'decline']),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  message: z.string().trim().min(1).max(2000).optional(),
  allowScope: allowScopeSchema.optional(),
  allowPattern: allowRuleTextSchema.optional(),
});
export const decideDelegationSchema = z.strictObject({
  sessionId: z.uuid(),
  runId: z.uuid(),
  delegationId: z.uuid(),
  decision: z.enum(['accept', 'decline']),
});
export const decideWorkerPlanSchema = z
  .strictObject({
    sessionId: z.uuid(),
    runId: z.uuid(),
    delegationId: z.uuid(),
    decision: z.enum(['accept', 'correct', 'decline']),
    correction: z.string().trim().min(1).max(4000).optional(),
  })
  .refine(value => value.decision !== 'correct' || !!value.correction, {
    message: 'A correction is required',
    path: ['correction'],
  });
const tokenCountSchema = z.number().int().nonnegative().nullable();
export const turnUsageSchema = z.strictObject({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cachedInputTokens: tokenCountSchema,
  costUsd: z.number().nonnegative().nullable(),
  source: z.literal('provider-report').nullable(),
  durationMs: tokenCountSchema,
});
export type TurnUsage = z.infer<typeof turnUsageSchema>;
export const sessionContextSchema = z.strictObject({
  usedTokens: z.number().int().nonnegative(),
  windowTokens: z.number().int().positive(),
  reportedAt: z.iso.datetime(),
});
export type SessionContext = z.infer<typeof sessionContextSchema>;
export const sessionCompactionLimit = 200;
export const sessionCompactionSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  at: z.iso.datetime(),
  instructions: z.boolean(),
});
export type SessionCompaction = z.infer<typeof sessionCompactionSchema>;
export const turnQuestionSchema = z
  .array(
    z.strictObject({
      text: z.string().trim().min(1).max(2000),
      options: z.array(z.string().trim().min(1).max(200)).max(6),
      multiple: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(4);
export type TurnQuestion = z.infer<typeof turnQuestionSchema>;

export const turnOutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('decision-needed') }),
  z.strictObject({
    kind: z.literal('question-for-you'),
    questions: turnQuestionSchema,
    route: decisionRouteSchema,
    source: z.literal('stage').optional(),
  }),
  z.strictObject({ kind: z.literal('result-to-review') }),
  z.strictObject({ kind: z.literal('done') }),
]);
export type TurnOutcome = z.infer<typeof turnOutcomeSchema>;

export const sessionMessageSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  author: z.enum(['operator', 'agent']),
  body: z.string().max(2_000_000),
  state: sessionStateSchema,
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable().default(null),
  skillId: z.string().min(1).max(8192).optional(),
  skillHash: skillHashSchema.optional(),
  skill: skillReferenceSchema.optional(),
  interruption: sessionInterruptionSchema.nullable().optional(),
  usage: turnUsageSchema.nullable().default(null),
  costWarning: z.string().max(2000).optional(),
  origin: z.enum(['workflow', 'imported']).nullable().default(null),
  model: z.string().nullable().default(null),
  effort: reasoningEffortSchema.nullable().default(null),
  mode: sessionModeSchema.nullable().default(null),
  mcp: messageMcpSchema.nullable().default(null),
  attachments: messageAttachmentsSchema.optional(),
  codeComments: messageCodeCommentsSchema.optional(),
  outcome: turnOutcomeSchema.optional(),
});
export function pendingTurnQuestion(
  session: Pick<Session, 'messages' | 'runId' | 'status'>,
) {
  const latest = session.messages.at(-1);
  return session.status === 'completed' &&
    latest &&
    latest.runId === session.runId &&
    latest.outcome?.kind === 'question-for-you' &&
    latest.outcome.source !== 'stage'
    ? { runId: latest.runId, messageId: latest.id, ...latest.outcome }
    : undefined;
}

export const sessionSchema = z.strictObject({
  id: z.uuid(),
  provider: providerSchema,
  profileId: z.uuid().nullable().optional(),
  providerSessionId: z.string().min(1).max(200).nullable(),
  providerInitialized: z.boolean(),
  title: z.string(),
  model: modelSchema,
  effort: reasoningEffortSchema.nullable().default(null),
  mode: sessionModeSchema.default('read-only'),
  pendingApprovals: z.array(approvalSchema).max(20).default([]),
  actualModel: z.string().nullable(),
  role: z.enum(['orchestrator', 'standalone', 'worker']),
  parentId: z.uuid().nullable().default(null),
  parentRunId: z.uuid().nullable().default(null),
  scope: z.string().max(1000).nullable().default(null),
  delegationEnabled: z.boolean().default(false),
  turnChildren: z
    .array(
      z.strictObject({ runId: z.uuid(), sessionIds: z.array(z.uuid()).max(8) }),
    )
    .max(200)
    .optional(),
  coordinatorWait: z
    .strictObject({
      runId: z.uuid(),
      cursor: z.number().int().nonnegative(),
      startedAt: z.iso.datetime(),
      away: z.boolean(),
      workers: z
        .array(
          z.strictObject({ sessionId: z.uuid(), runId: z.uuid().nullable() }),
        )
        .max(8),
    })
    .optional(),
  delegations: z.array(delegationSchema).max(100).default([]),
  workflowRunId: z.uuid().nullable().default(null),
  workflowStepId: z.uuid().nullable().default(null),
  workflow: sessionWorkflowSchema.nullable().default(null),
  reviewEveryResult: z.boolean().optional(),
  decisionRouteOverride: decisionRouteSchema.optional(),
  questionRouteOverride: decisionRouteSchema.optional(),
  mcp: sessionMcpSchema.default({ servers: [], hooks: false }),
  pullRequest: pullRequestReferenceSchema.nullable().default(null),
  pullRequestDismissed: z.array(pullRequestReferenceSchema).max(20).default([]),
  scheduledJobId: z.uuid().nullable().default(null),
  scheduledJobRunId: z.uuid().nullable().default(null),
  directory: z.string(),
  worktree: sessionWorktreeSchema.optional(),
  status: sessionStateSchema,
  error: z.string().nullable(),
  interruption: sessionInterruptionSchema.nullable().optional(),
  activity: z.string().nullable(),
  activities: z
    .array(sessionActivitySchema)
    .max(activityLimits.items)
    .default([]),
  activitiesTruncated: z.boolean().default(false),
  activityTruncatedRunIds: z
    .array(z.uuid())
    .max(activityLimits.items)
    .default([]),
  runId: z.uuid().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(sessionMessageSchema),
  forkOf: z
    .strictObject({
      sessionId: z.uuid(),
      title: z.string(),
      messageId: z.uuid().nullable(),
    })
    .nullable()
    .default(null),
  pendingClaudeFork: z.uuid().nullable().default(null),
  providerThreadStarts: z.array(z.number().int().nonnegative()).default([]),
  context: sessionContextSchema.nullable().default(null),
  compactions: z
    .array(sessionCompactionSchema)
    .max(sessionCompactionLimit)
    .default([]),
  queue: z.array(queuedMessageSchema).max(sessionQueueLimit).default([]),
  groupId: z.uuid().nullable().default(null),
  order: z.number().int().default(0),
  pinned: z.boolean().default(false),
  archivedAt: z.iso.datetime().nullable().default(null),
  externalAttachment: z
    .strictObject({ attachedAt: z.iso.datetime() })
    .nullable()
    .default(null),
  parentRequest: sessionParentRequestSchema.nullable().default(null),
  plan: sessionPlanSchema.nullable().default(null),
  stageRecords: z
    .array(sessionStageRecordSchema)
    .max(stageRecordLimit)
    .default([]),
  stageTools: z.boolean().default(false),
  browser: z.boolean().optional(),
  decisionRoute: decisionRouteSchema.optional(),
});
export const claudeStatusSchema = z.strictObject({
  status: z.enum([
    'ready',
    'missing',
    'unauthenticated',
    'unsupported',
    'error',
  ]),
  version: z.string().nullable(),
  detail: z.string().nullable(),
  models: z.array(z.strictObject({ id: claudeModelSchema, label: z.string() })),
  effort: effortSupportSchema.default({
    status: 'unsupported',
    reason:
      'This computer runs an older Nesvo host that does not report reasoning effort support. Update the host to choose an effort.',
  }),
  modes: z.array(sessionModeSchema).default([]),
  images: imageInputSupportSchema.default({
    status: 'unsupported',
    reason:
      'This computer runs an older Nesvo host that cannot send images. Update the host to attach images.',
  }),
  efforts: z.array(reasoningEffortOptionSchema).max(16).default([]),
  browser: browserSupportSchema.default({
    status: 'unsupported',
    reason:
      'This computer runs an older Nesvo host that cannot open a browser. Update the host to use the browser.',
  }),
});
export const codexStatusSchema = claudeStatusSchema
  .omit({ efforts: true, browser: true })
  .extend({
    models: z.array(
      z.strictObject({
        id: modelSchema,
        label: z.string(),
        efforts: modelEffortsSchema.nullable().default(null),
        images: z.boolean().default(false),
      }),
    ),
  });

export type SessionIsolation = z.infer<typeof sessionIsolationSchema>;
export type SessionWorktree = z.infer<typeof sessionWorktreeSchema>;
export type ReadSessionWorktreeInput = z.infer<
  typeof readSessionWorktreeSchema
>;
export type SessionWorktreeStatus = z.infer<typeof sessionWorktreeStatusSchema>;
export type RunSessionWorktreeSetupInput = z.infer<
  typeof runSessionWorktreeSetupSchema
>;
export type SessionWorktreeSetup = z.infer<typeof sessionWorktreeSetupSchema>;
export type SessionWorktreeSetupResult = z.infer<
  typeof sessionWorktreeSetupResultSchema
>;
export type OrphanedSessionWorktrees = z.infer<
  typeof orphanedSessionWorktreesSchema
>;
export type RemoveOrphanedSessionWorktreeInput = z.infer<
  typeof removeOrphanedSessionWorktreeSchema
>;
export type OrphanedSessionWorktreeRemoval = z.infer<
  typeof orphanedSessionWorktreeRemovalSchema
>;
export type FinishSessionWorktreeInput = z.infer<
  typeof finishSessionWorktreeSchema
>;
export type Session = z.infer<typeof sessionSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type ForkSessionInput = z.infer<typeof forkSessionSchema>;
export type RestartSessionInput = z.infer<typeof restartSessionSchema>;
export type CompactSessionInput = z.infer<typeof compactSessionSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type QueuedMessageRefInput = z.infer<typeof queuedMessageRefSchema>;
export type StopRunInput = z.infer<typeof stopRunSchema>;
export type ClaudeStatus = z.infer<typeof claudeStatusSchema>;
export type BrowserSupport = z.infer<typeof browserSupportSchema>;
export type CodexStatus = z.infer<typeof codexStatusSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SessionWorkflow = z.infer<typeof sessionWorkflowSchema>;
export type AssignSessionWorkflowInput = z.infer<
  typeof assignSessionWorkflowSchema
>;
export type Approval = z.infer<typeof approvalSchema>;
export type RespondApprovalInput = z.infer<typeof respondApprovalSchema>;
export type WorkerProposal = z.infer<typeof workerProposalSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type DelegationPlan = z.infer<typeof delegationPlanSchema>;
export type DecideDelegationInput = z.infer<typeof decideDelegationSchema>;
export type DecideWorkerPlanInput = z.infer<typeof decideWorkerPlanSchema>;
