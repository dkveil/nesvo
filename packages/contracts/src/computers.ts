import { z } from 'zod';
import { sessionSchema } from './sessions';
import { reviewSchema } from './reviews';
import {
  scheduledJobRunPageSchema,
  scheduledJobRunSchema,
  scheduledJobSchema,
} from './scheduled-jobs';
import {
  pipelineRunDetailSchema,
  pipelineRunPageSchema,
  pipelineRunSchema,
  pipelineStepRecordSchema,
} from './pipelines';

export const hostIdSchema = z.union([z.literal('local'), z.uuid()]);
export type HostId = z.infer<typeof hostIdSchema>;

export const hostCapabilitySchema = z.enum([
  'scheduled-jobs',
  'reasoning-effort',
  'pipelines',
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
    'error',
  ]),
  instanceId: z.uuid().nullable(),
  lastSyncedAt: z.iso.datetime().nullable(),
  error: z.string().max(2000).nullable(),
  capabilities: z.array(hostCapabilitySchema).max(16),
  ssh: sshComputerInputSchema.optional(),
});
export type Computer = z.infer<typeof computerSchema>;

export const desktopSessionSchema = sessionSchema.extend({
  hostId: hostIdSchema,
});
export const desktopReviewSchema = reviewSchema.extend({
  hostId: hostIdSchema,
});
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
export const desktopPipelineRunSchema = pipelineRunSchema.extend({
  hostId: hostIdSchema,
});
export const desktopPipelineStepRecordSchema = pipelineStepRecordSchema.extend({
  hostId: hostIdSchema,
});
export const desktopPipelineRunPageSchema = pipelineRunPageSchema.extend({
  runs: z.array(desktopPipelineRunSchema),
});
export const desktopPipelineRunDetailSchema = pipelineRunDetailSchema.extend({
  run: desktopPipelineRunSchema,
  steps: z.array(desktopPipelineStepRecordSchema),
});
export type DesktopSession = z.infer<typeof desktopSessionSchema>;
export type DesktopReview = z.infer<typeof desktopReviewSchema>;
export type DesktopScheduledJob = z.infer<typeof desktopScheduledJobSchema>;
export type DesktopScheduledJobRun = z.infer<
  typeof desktopScheduledJobRunSchema
>;
export type DesktopScheduledJobRunPage = z.infer<
  typeof desktopScheduledJobRunPageSchema
>;

export type DesktopPipelineRun = z.infer<typeof desktopPipelineRunSchema>;
export type DesktopPipelineStepRecord = z.infer<
  typeof desktopPipelineStepRecordSchema
>;
export type DesktopPipelineRunPage = z.infer<
  typeof desktopPipelineRunPageSchema
>;
export type DesktopPipelineRunDetail = z.infer<
  typeof desktopPipelineRunDetailSchema
>;

export const workspaceEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-changed'),
    session: desktopSessionSchema,
  }),
  z.strictObject({
    type: z.literal('review-changed'),
    review: desktopReviewSchema,
  }),
  z.strictObject({
    type: z.literal('host-disconnected'),
    hostId: hostIdSchema,
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
    type: z.literal('pipeline-run-changed'),
    run: desktopPipelineRunSchema,
  }),
  z.strictObject({
    type: z.literal('pipeline-step-changed'),
    step: desktopPipelineStepRecordSchema,
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
