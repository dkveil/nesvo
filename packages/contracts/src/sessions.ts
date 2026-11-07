import { z } from 'zod';

export const claudeModelSchema = z.enum(['default', 'opus', 'sonnet', 'haiku']);
export const providerSchema = z.enum(['Claude Code', 'Codex']);
export const sessionModeSchema = z.enum(['read-only', 'supervised']);
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
  })
  .superRefine((value, context) => {
    if (
      value.provider === 'Claude Code' &&
      (value.mode !== 'read-only' ||
        !claudeModelSchema.safeParse(value.model).success)
    )
      context.addIssue({
        code: 'custom',
        message: 'Unsupported Claude worker configuration',
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
    'running',
    'completed',
    'stopped',
    'failed',
    'interrupted',
  ]),
  childSessionId: z.uuid().nullable(),
  error: z.string().nullable(),
});
export const approvalSchema = z.strictObject({
  id: z.string().min(1).max(200),
  kind: z.enum(['command', 'file-change']),
  title: z.string().min(1).max(500),
  detail: z.string().max(100_000),
  directory: z.string().max(4096).nullable(),
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
export const createSessionSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(100),
    provider: providerSchema.default('Claude Code'),
    model: modelSchema,
    mode: sessionModeSchema.default('read-only'),
    role: z.enum(['orchestrator', 'standalone']),
    directory: z.string().trim().max(4096),
  })
  .superRefine((value, context) => {
    if (
      value.provider === 'Claude Code' &&
      (value.mode !== 'read-only' ||
        !claudeModelSchema.safeParse(value.model).success)
    )
      context.addIssue({
        code: 'custom',
        message: 'Unsupported Claude Code model or mode',
      });
  });
export const sendMessageSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  text: z.string().trim().min(1).max(32000),
});
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
export const sessionMessageSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  author: z.enum(['operator', 'agent']),
  body: z.string().max(2_000_000),
  state: sessionStateSchema,
  createdAt: z.iso.datetime(),
});
export const sessionSchema = z.strictObject({
  id: z.uuid(),
  provider: providerSchema,
  providerSessionId: z.string().min(1).max(200).nullable(),
  providerInitialized: z.boolean(),
  title: z.string(),
  model: modelSchema,
  mode: sessionModeSchema.default('read-only'),
  pendingApprovals: z.array(approvalSchema).max(20).default([]),
  actualModel: z.string().nullable(),
  role: z.enum(['orchestrator', 'standalone', 'worker']),
  parentId: z.uuid().nullable().default(null),
  parentRunId: z.uuid().nullable().default(null),
  scope: z.string().max(1000).nullable().default(null),
  delegationEnabled: z.boolean().default(false),
  delegations: z.array(delegationSchema).max(100).default([]),
  directory: z.string(),
  status: sessionStateSchema,
  error: z.string().nullable(),
  activity: z.string().nullable(),
  runId: z.uuid().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(sessionMessageSchema),
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
});
export const codexStatusSchema = claudeStatusSchema.extend({
  models: z.array(z.strictObject({ id: modelSchema, label: z.string() })),
});
export const desktopEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-changed'),
    session: sessionSchema,
  }),
  z.strictObject({ type: z.literal('host-disconnected') }),
]);

export type Session = z.infer<typeof sessionSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type StopRunInput = z.infer<typeof stopRunSchema>;
export type ClaudeStatus = z.infer<typeof claudeStatusSchema>;
export type CodexStatus = z.infer<typeof codexStatusSchema>;
export type Provider = z.infer<typeof providerSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type RespondApprovalInput = z.infer<typeof respondApprovalSchema>;
export type WorkerProposal = z.infer<typeof workerProposalSchema>;
export type Delegation = z.infer<typeof delegationSchema>;
export type DelegationPlan = z.infer<typeof delegationPlanSchema>;
export type DecideDelegationInput = z.infer<typeof decideDelegationSchema>;
export type DesktopEvent = z.infer<typeof desktopEventSchema>;
