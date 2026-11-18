import { z } from 'zod';
import { pullRequestReferenceSchema } from './pull-requests';
import { activityLimits, sessionActivitySchema } from './activities';
import {
  effortSupportSchema,
  modelEffortsSchema,
  reasoningEffortSchema,
} from './reasoning-effort';
import { skillHashSchema, skillReferenceSchema } from './skills';
import {
  mcpSelectionSchema,
  messageMcpSchema,
  sessionMcpSchema,
} from './mcp-selection';

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
  kind: z.enum(['command', 'file-change', 'tool']),
  title: z.string().min(1).max(500),
  detail: z.string().max(100_000),
  directory: z.string().max(4096).nullable(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
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
export const sessionWorktreeSchema = z.strictObject({
  projectDirectory: z.string().min(1).max(4096),
  branch: z.string().min(1).max(200).regex(SESSION_BRANCH_PATTERN),
  base: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  state: z.enum(['active', 'kept', 'removed']),
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
    model: modelSchema,
    mode: sessionModeSchema.default('read-only'),
    role: z.enum(['orchestrator', 'standalone']).optional(),
    directory: z.string().trim().max(4096),
    effort: reasoningEffortSchema.optional(),
    isolation: sessionIsolationSchema.optional(),
    groupId: z.uuid().optional(),
    mcp: mcpSelectionSchema.optional(),
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
export const sendMessageSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  text: z.string().trim().min(1).max(32000),
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
export const forkSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  worktree: z
    .strictObject({ carryChanges: z.boolean().default(false) })
    .optional(),
});
export const restartSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  revision: z.number().int().nonnegative(),
});
export const queuedMessageSchema = z.strictObject({
  id: z.uuid(),
  text: z.string().trim().min(1).max(32000),
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
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  message: z.string().trim().min(1).max(2000).optional(),
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
  mcp: sessionMcpSchema.default({ servers: [], hooks: false }),
  pullRequest: pullRequestReferenceSchema.nullable().default(null),
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
  queue: z.array(queuedMessageSchema).max(sessionQueueLimit).default([]),
  groupId: z.uuid().nullable().default(null),
  order: z.number().int().default(0),
  pinned: z.boolean().default(false),
  archivedAt: z.iso.datetime().nullable().default(null),
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
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type ForkSessionInput = z.infer<typeof forkSessionSchema>;
export type RestartSessionInput = z.infer<typeof restartSessionSchema>;
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
export type WorkerProposal = z.infer<typeof workerProposalSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type DelegationPlan = z.infer<typeof delegationPlanSchema>;
export type DecideDelegationInput = z.infer<typeof decideDelegationSchema>;
export type DecideWorkerPlanInput = z.infer<typeof decideWorkerPlanSchema>;
