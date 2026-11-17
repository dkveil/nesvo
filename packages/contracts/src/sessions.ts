import { z } from 'zod';
import { activityLimits, sessionActivitySchema } from './activities';
import {
  effortSupportSchema,
  modelEffortsSchema,
  reasoningEffortSchema,
} from './reasoning-effort';
import { skillHashSchema, skillReferenceSchema } from './skills';

export const claudeModelSchema = z.enum(['default', 'opus', 'sonnet', 'haiku']);
export const providerSchema = z.enum(['Claude Code', 'Codex']);
export const sessionModeSchema = z.enum([
  'read-only',
  'supervised',
  'accept-edits',
  'auto',
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
        (value.mode !== 'read-only' ||
          !claudeModelSchema.safeParse(value.model).success))
    )
      context.addIssue({
        code: 'custom',
        message: `Unsupported ${value.provider} worker configuration`,
      });
  });
export const delegationPlanSchema = z.strictObject({
  workers: z.array(workerProposalSchema).min(1).max(2),
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
  kind: z.enum(['command', 'file-change']),
  title: z.string().min(1).max(500),
  detail: z.string().max(100_000),
  directory: z.string().max(4096).nullable(),
});
export const promptQuestionSchema = z.strictObject({
  question: z.string().min(1).max(2000),
  header: z.string().max(200),
  options: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(500),
        description: z.string().max(2000),
      }),
    )
    .min(1)
    .max(20),
  multiSelect: z.boolean(),
});
const promptAnswersSchema = z
  .record(z.string().min(1).max(2000), z.string().max(2000))
  .refine(value => Object.keys(value).length <= 10, {
    message: 'Answer at most ten questions',
  });
export const sessionPromptSchema = z.strictObject({
  id: z.string().min(1).max(200),
  runId: z.uuid(),
  kind: z.enum(['question', 'plan']),
  status: z.enum([
    'pending',
    'answered',
    'accepted',
    'revised',
    'declined',
    'interrupted',
  ]),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  questions: z.array(promptQuestionSchema).max(10).default([]),
  answers: promptAnswersSchema.nullable(),
  plan: z.string().max(40_000).nullable(),
  planRound: z.number().int().min(1).default(1),
  decision: z
    .strictObject({
      mode: sessionModeSchema.optional(),
      feedback: z.string().max(8000).optional(),
    })
    .nullable(),
});
export const planAcceptModeSchema = sessionModeSchema.extract([
  'accept-edits',
  'auto',
]);
export const promptAnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question'), answers: promptAnswersSchema }),
  z.discriminatedUnion('decision', [
    z.strictObject({
      kind: z.literal('plan'),
      decision: z.literal('accept'),
      mode: planAcceptModeSchema,
    }),
    z.strictObject({
      kind: z.literal('plan'),
      decision: z.literal('revise'),
      feedback: z.string().trim().min(1).max(8000),
    }),
  ]),
]);
export const answerPromptSchema = z.strictObject({
  sessionId: z.uuid(),
  runId: z.uuid(),
  promptId: z.string().min(1).max(200),
  answer: promptAnswerSchema,
});
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
export const sessionFailureSchema = z.strictObject({
  kind: z.enum([
    'usage-limit',
    'sign-in',
    'network',
    'crash',
    'timeout',
    'provider',
    'host',
  ]),
  message: z.string().max(2000),
  resetsAt: z.iso.datetime().nullable(),
  exitCode: z.number().int().nullable(),
  detail: z.string().max(4000).nullable(),
});
export type SessionFailure = z.infer<typeof sessionFailureSchema>;
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
});
export const createSessionSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(100),
    provider: providerSchema.default('Claude Code'),
    model: modelSchema,
    mode: sessionModeSchema.default('read-only'),
    role: z.enum(['orchestrator', 'standalone']).optional(),
    directory: z.string().trim().max(4096),
    effort: reasoningEffortSchema.optional(),
    isolation: sessionIsolationSchema.optional(),
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
    if (
      value.effort &&
      (value.provider === 'Claude Code' || value.model === 'default')
    )
      context.addIssue({
        code: 'custom',
        path: ['effort'],
        message:
          value.provider === 'Claude Code'
            ? 'Claude Code sessions do not accept a reasoning effort'
            : 'Choose a specific Codex model to set a reasoning effort',
      });
  });
export const attachmentLimits = {
  perMessage: 10,
  imageBytes: 5_242_880,
  textBytes: 204_800,
  encodedCharacters: 7_000_000,
  pastedTextCharacters: 4000,
} as const;
export const attachmentKindSchema = z.enum(['image', 'text']);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;
export const attachmentMediaTypes = {
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  text: ['text/plain', 'text/markdown', 'text/csv', 'application/json'],
} as const satisfies Record<AttachmentKind, readonly string[]>;
const TEXT_SUBTYPE_PATTERN = /^text\/x-[a-z0-9.+-]{1,80}$/;
export const isAttachmentMediaType = (
  kind: AttachmentKind,
  mediaType: string,
): boolean =>
  (attachmentMediaTypes[kind] as readonly string[]).includes(mediaType) ||
  (kind === 'text' && TEXT_SUBTYPE_PATTERN.test(mediaType));
export const attachmentByteLimit = (kind: AttachmentKind): number =>
  kind === 'image' ? attachmentLimits.imageBytes : attachmentLimits.textBytes;
export const messageAttachmentSchema = z
  .strictObject({
    id: z.uuid(),
    kind: attachmentKindSchema,
    name: z
      .string()
      .min(1)
      .max(255)
      .refine(
        value =>
          !/[\\/\u0000-\u001f\u007f]/.test(value) &&
          value !== '.' &&
          value !== '..',
        'Use a file name without folders.',
      ),
    mediaType: z.string().min(1).max(100),
    bytes: z.number().int().min(1).max(attachmentLimits.imageBytes),
  })
  .superRefine((value, context) => {
    if (!isAttachmentMediaType(value.kind, value.mediaType))
      context.addIssue({
        code: 'custom',
        path: ['mediaType'],
        message: 'This file type cannot be attached.',
      });
    if (value.bytes > attachmentByteLimit(value.kind))
      context.addIssue({
        code: 'custom',
        path: ['bytes'],
        message: 'This file is too large to attach.',
      });
  });
const messageAttachmentsSchema = z
  .array(messageAttachmentSchema)
  .max(attachmentLimits.perMessage);
const attachmentDataSchema = z.base64().max(attachmentLimits.encodedCharacters);
export const stageAttachmentSchema = z.strictObject({
  sessionId: z.uuid(),
  attachment: messageAttachmentSchema,
  data: attachmentDataSchema,
});
export const readAttachmentSchema = z.strictObject({
  sessionId: z.uuid(),
  attachmentId: z.uuid(),
});
export const stagedAttachmentIdSchema = z.strictObject({ id: z.uuid() });
export const stagedAttachmentSchema = z.strictObject({
  attachment: messageAttachmentSchema,
  data: attachmentDataSchema,
});
const messageTextSchema = z.string().trim().max(32000);
export const sendMessageSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  text: messageTextSchema,
  attachments: messageAttachmentsSchema.optional(),
  skillId: z.string().min(1).max(8192).optional(),
  skillHash: skillHashSchema.optional(),
  model: modelSchema.optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  mode: sessionModeSchema.optional(),
});
export const assignSessionWorkflowSchema = z.strictObject({
  sessionId: z.uuid(),
  workflow: sessionWorkflowSchema.nullable(),
});
export const queuedMessageSchema = z.strictObject({
  id: z.uuid(),
  text: messageTextSchema,
  attachments: messageAttachmentsSchema.default([]),
  skillId: z.string().min(1).max(8192).optional(),
  skillHash: skillHashSchema.optional(),
  model: modelSchema.optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  mode: sessionModeSchema.optional(),
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
export const sessionMessageSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  author: z.enum(['operator', 'agent']),
  body: z.string().max(2_000_000),
  attachments: messageAttachmentsSchema.default([]),
  state: sessionStateSchema,
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable().default(null),
  skillId: z.string().min(1).max(8192).optional(),
  skillHash: skillHashSchema.optional(),
  skill: skillReferenceSchema.optional(),
  interruption: sessionInterruptionSchema.nullable().optional(),
  usage: turnUsageSchema.nullable().default(null),
  origin: z.literal('workflow').nullable().default(null),
  model: z.string().nullable().default(null),
  effort: reasoningEffortSchema.nullable().default(null),
  mode: sessionModeSchema.nullable().default(null),
  failure: sessionFailureSchema.nullable().default(null),
});
export const sessionSchema = z.strictObject({
  id: z.uuid(),
  provider: providerSchema,
  providerSessionId: z.string().min(1).max(200).nullable(),
  providerInitialized: z.boolean(),
  title: z.string(),
  model: modelSchema,
  effort: reasoningEffortSchema.nullable().default(null),
  mode: sessionModeSchema.default('read-only'),
  pendingApprovals: z.array(approvalSchema).max(20).default([]),
  prompts: z.array(sessionPromptSchema).max(50).default([]),
  actualModel: z.string().nullable(),
  role: z.enum(['orchestrator', 'standalone', 'worker']),
  parentId: z.uuid().nullable().default(null),
  parentRunId: z.uuid().nullable().default(null),
  scope: z.string().max(1000).nullable().default(null),
  delegationEnabled: z.boolean().default(false),
  delegations: z.array(delegationSchema).max(100).default([]),
  workflowRunId: z.uuid().nullable().default(null),
  workflowStepId: z.uuid().nullable().default(null),
  workflow: sessionWorkflowSchema.nullable().default(null),
  scheduledJobId: z.uuid().nullable().default(null),
  scheduledJobRunId: z.uuid().nullable().default(null),
  directory: z.string(),
  status: sessionStateSchema,
  error: z.string().nullable(),
  failure: sessionFailureSchema.nullable().default(null),
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
  queue: z.array(queuedMessageSchema).max(sessionQueueLimit).default([]),
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
});
export const codexStatusSchema = claudeStatusSchema.extend({
  models: z.array(
    z.strictObject({
      id: modelSchema,
      label: z.string(),
      efforts: modelEffortsSchema.nullable().default(null),
    }),
  ),
});

export type SessionIsolation = z.infer<typeof sessionIsolationSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;
export type StageAttachmentInput = z.infer<typeof stageAttachmentSchema>;
export type ReadAttachmentInput = z.infer<typeof readAttachmentSchema>;
export type StagedAttachment = z.infer<typeof stagedAttachmentSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type QueuedMessageRefInput = z.infer<typeof queuedMessageRefSchema>;
export type StopRunInput = z.infer<typeof stopRunSchema>;
export type ClaudeStatus = z.infer<typeof claudeStatusSchema>;
export type CodexStatus = z.infer<typeof codexStatusSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SessionWorkflow = z.infer<typeof sessionWorkflowSchema>;
export type AssignSessionWorkflowInput = z.infer<
  typeof assignSessionWorkflowSchema
>;
export type Approval = z.infer<typeof approvalSchema>;
export type RespondApprovalInput = z.infer<typeof respondApprovalSchema>;
export type PromptQuestion = z.infer<typeof promptQuestionSchema>;
export type SessionPrompt = z.infer<typeof sessionPromptSchema>;
export type PromptAnswer = z.infer<typeof promptAnswerSchema>;
export type PlanAcceptMode = z.infer<typeof planAcceptModeSchema>;
export type AnswerPromptInput = z.infer<typeof answerPromptSchema>;
export type WorkerProposal = z.infer<typeof workerProposalSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type DelegationPlan = z.infer<typeof delegationPlanSchema>;
export type DecideDelegationInput = z.infer<typeof decideDelegationSchema>;
export type DecideWorkerPlanInput = z.infer<typeof decideWorkerPlanSchema>;
