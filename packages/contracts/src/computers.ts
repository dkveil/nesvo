import { z } from 'zod';
import { sessionMetadataSchema, sessionWindowSchema } from './session-history';
import { reviewSchema } from './reviews';
import { reviewDraftSchema } from './code-review';
import { sessionMessageSchema } from './sessions';
import { sessionGroupListSchema } from './session-groups';
import {
  scheduledJobRunPageSchema,
  scheduledJobRunSchema,
  scheduledJobSchema,
} from './scheduled-jobs';
import {
  workflowRunDetailSchema,
  workflowRunPageSchema,
  workflowRunSchema,
  workflowStepRecordSchema,
  workflowAssistantProposalEventSchema,
  assistantChangeEventSchema,
  assistantChangeRefusedEventSchema,
} from './workflows';

export const hostIdSchema = z.union([z.literal('local'), z.uuid()]);
export type HostId = z.infer<typeof hostIdSchema>;

export const hostCapabilitySchema = z.enum([
  'scheduled-jobs',
  'reasoning-effort',
  'workflows',
  'git-branch',
  'session-worktrees',
  'session-worktree-tools',
  'permission-modes',
  'session-workflow',
  'session-fork',
  'pull-requests',
  'history-search',
  'session-groups',
  'costs',
  'mcp-servers',
  'conversation-import',
  'scheduled-job-change-triggers',
  'database-backup',
  'claude-approvals',
  'message-attachments',
  'terminal-handoff',
  'transcript-search',
  'session-delete',
  'conversation-compaction',
  'provider-profiles',
  'inline-attachments',
  'pull-request-reviews',
  'file-attachments',
  'session-changes',
  'code-comments',
  'repository-mcp-trust',
  'tracked-repositories',
  'running-apps',
  'default-session-folder',
  'worktree-recipes',
  'session-control',
  'workflow-sharing',
]);
export type HostCapability = z.infer<typeof hostCapabilitySchema>;

const pathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const remotePathSchema = pathSchema.refine(
  value => value.startsWith('/'),
  'Use an absolute Linux path.',
);

const remoteExecutablePathSchema = z
  .string()
  .trim()
  .min(2)
  .max(1024)
  .regex(
    /^(?:\/[A-Za-z0-9._+@:,%-]+)+$/,
    'Use an absolute Linux path without spaces, quotes or shell characters.',
  );

export const sshComputerInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  hostname: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine(
      value =>
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) ||
        z.ipv6().safeParse(value).success,
      'Use a hostname, SSH alias or IP address.',
    ),
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/)
    .optional(),
  port: z.number().int().min(1).max(65535).default(22),
  identityFile: pathSchema.optional(),
  knownHostsFile: pathSchema.optional(),
  nodePath: remoteExecutablePathSchema.optional(),
  entryPath: remotePathSchema,
  runtimeDirectory: remotePathSchema,
});
export type SshComputerInput = z.infer<typeof sshComputerInputSchema>;

export const computerSchema = z.strictObject({
  id: hostIdSchema,
  name: z.string().min(1).max(80),
  kind: z.enum(['local', 'ssh']),
  status: z.enum([
    'connecting',
    'syncing',
    'connected',
    'disconnected',
    'incompatible',
    'error',
  ]),
  instanceId: z.uuid().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  error: z.string().max(2000).nullable(),
  capabilities: z.array(hostCapabilitySchema).max(64),
  ssh: sshComputerInputSchema.optional(),
});
export type Computer = z.infer<typeof computerSchema>;

export const desktopSessionSchema = sessionWindowSchema.extend({
  hostId: hostIdSchema,
});
export const desktopSessionMessageUpsertSchema = z.strictObject({
  type: z.literal('session-message-upserted'),
  baseRevision: z.number().int().nonnegative(),
  session: sessionMetadataSchema.extend({ hostId: hostIdSchema }),
  index: z.number().int().nonnegative(),
  message: sessionMessageSchema,
});
export type DesktopSessionMessageUpsert = z.infer<
  typeof desktopSessionMessageUpsertSchema
>;
export const desktopReviewSchema = reviewSchema.extend({
  hostId: hostIdSchema,
});
export const desktopReviewDraftSchema = reviewDraftSchema.extend({
  hostId: hostIdSchema,
});
export const desktopReviewPublishResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('published'),
    draft: desktopReviewDraftSchema,
  }),
  z.strictObject({
    status: z.literal('head-moved'),
    currentHeadSha: z.string().regex(/^[0-9a-f]{40}$/),
    draft: desktopReviewDraftSchema,
  }),
]);
export type DesktopReviewDraft = z.infer<typeof desktopReviewDraftSchema>;
export type DesktopReviewPublishResult = z.infer<
  typeof desktopReviewPublishResultSchema
>;
export const desktopScheduledJobSchema = scheduledJobSchema.safeExtend({
  hostId: hostIdSchema,
});
export const desktopScheduledJobRunSchema = scheduledJobRunSchema.safeExtend({
  hostId: hostIdSchema,
});
export const desktopScheduledJobRunPageSchema =
  scheduledJobRunPageSchema.extend({
    runs: z.array(desktopScheduledJobRunSchema),
  });
export const desktopWorkflowRunSchema = workflowRunSchema.extend({
  hostId: hostIdSchema,
});
export const desktopWorkflowStepRecordSchema = workflowStepRecordSchema.extend({
  hostId: hostIdSchema,
});
export const desktopWorkflowRunPageSchema = workflowRunPageSchema.extend({
  runs: z.array(desktopWorkflowRunSchema),
});
export const desktopWorkflowRunDetailSchema = workflowRunDetailSchema.extend({
  run: desktopWorkflowRunSchema,
  steps: z.array(desktopWorkflowStepRecordSchema),
});
export const desktopWorkflowAssistantProposalSchema =
  workflowAssistantProposalEventSchema.extend({ hostId: hostIdSchema });
export type DesktopSession = z.infer<typeof desktopSessionSchema>;
export const openedSessionTerminalSchema = z.strictObject({
  session: desktopSessionSchema,
  terminal: z.string().min(1).max(100),
});
export type OpenedSessionTerminal = z.infer<typeof openedSessionTerminalSchema>;
export type DesktopReview = z.infer<typeof desktopReviewSchema>;
export type DesktopScheduledJob = z.infer<typeof desktopScheduledJobSchema>;
export type DesktopScheduledJobRun = z.infer<
  typeof desktopScheduledJobRunSchema
>;
export type DesktopScheduledJobRunPage = z.infer<
  typeof desktopScheduledJobRunPageSchema
>;

export type DesktopWorkflowRun = z.infer<typeof desktopWorkflowRunSchema>;
export type DesktopWorkflowStepRecord = z.infer<
  typeof desktopWorkflowStepRecordSchema
>;
export type DesktopWorkflowRunPage = z.infer<
  typeof desktopWorkflowRunPageSchema
>;
export type DesktopWorkflowRunDetail = z.infer<
  typeof desktopWorkflowRunDetailSchema
>;

export const workspaceEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-changed'),
    session: desktopSessionSchema,
  }),
  desktopSessionMessageUpsertSchema,
  z.strictObject({
    type: z.literal('review-changed'),
    review: desktopReviewSchema,
  }),
  z.strictObject({
    type: z.literal('host-disconnected'),
    hostId: hostIdSchema,
  }),
  z.strictObject({
    type: z.literal('sessions-removed'),
    hostId: hostIdSchema,
    sessionIds: z.array(z.uuid()).min(1).max(500),
  }),
  z.strictObject({
    type: z.literal('scheduled-job-changed'),
    scheduledJob: desktopScheduledJobSchema,
  }),
  z.strictObject({
    type: z.literal('scheduled-job-removed'),
    hostId: hostIdSchema,
    scheduledJobId: z.uuid(),
    revision: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('scheduled-job-run-changed'),
    run: desktopScheduledJobRunSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-run-changed'),
    run: desktopWorkflowRunSchema,
  }),
  z.strictObject({
    type: z.literal('workflow-step-changed'),
    step: desktopWorkflowStepRecordSchema,
  }),
  desktopWorkflowAssistantProposalSchema.extend({
    type: z.literal('workflow-assistant-proposal'),
  }),
  assistantChangeEventSchema.extend({
    type: z.literal('workflow-assistant-change'),
    hostId: hostIdSchema,
  }),
  assistantChangeRefusedEventSchema.extend({
    type: z.literal('workflow-assistant-change-refused'),
    hostId: hostIdSchema,
  }),
  z.strictObject({
    type: z.literal('session-groups-changed'),
    hostId: hostIdSchema,
    list: sessionGroupListSchema,
  }),
  z.strictObject({
    type: z.literal('pull-request-review-changed'),
    draft: desktopReviewDraftSchema,
  }),
  z.strictObject({
    type: z.literal('computers-changed'),
    computers: z.array(computerSchema).max(9),
  }),
  z.strictObject({
    type: z.literal('host-snapshot'),
    hostId: hostIdSchema,
    sessions: z.array(desktopSessionSchema),
    reviews: z.array(desktopReviewSchema),
  }),
]);
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;
