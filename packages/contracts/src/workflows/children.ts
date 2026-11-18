import { z } from 'zod';
import { reasoningEffortSchema } from '../reasoning-effort';
import {
  isProviderSessionMode,
  providerSchema,
  sessionModeSchema,
} from '../sessions';
import { STEP_OUTPUT_REFERENCE } from './expressions';

export const workflowChildItemLimit = 32;

const itemFailureSchema = z.enum(['continue', 'stop-remaining', 'fail-run']);
const itemObjectSchema = z
  .record(
    z.string().max(64),
    z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]),
  )
  .refine(
    value => Object.keys(value).length <= 16,
    'Use at most 16 item fields.',
  )
  .refine(
    value =>
      value.on_fail === undefined ||
      itemFailureSchema.safeParse(value.on_fail).success,
    'Use continue, stop-remaining or fail-run for an item’s on_fail.',
  );
export const workflowItemsSchema = z
  .array(z.union([z.string().min(1).max(4000), itemObjectSchema]))
  .max(workflowChildItemLimit);

export const workflowItemSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inline'), values: workflowItemsSchema }),
  z.strictObject({
    kind: z.literal('file'),
    path: z.string().min(1).max(4096),
  }),
  z.strictObject({
    kind: z.literal('output'),
    reference: z.string().max(200).regex(STEP_OUTPUT_REFERENCE),
  }),
]);

export const workflowChildPolicySchema = z
  .strictObject({
    max_parallel: z.number().int().min(1).max(workflowChildItemLimit),
    soft_limit: z.number().int().min(1).max(workflowChildItemLimit).optional(),
    min_free_ram_mb: z.number().int().nonnegative().max(1_048_576),
    min_plan_remaining_percent: z.number().min(0).max(100),
    max_cpu_load_percent: z.number().positive().max(100).optional(),
    on_fail: itemFailureSchema,
  })
  .refine(
    value =>
      value.soft_limit === undefined || value.soft_limit <= value.max_parallel,
    {
      path: ['soft_limit'],
      message: 'The soft limit cannot exceed the hard limit.',
    },
  );

export const workflowChildSessionSchema = z
  .strictObject({
    workflow: z
      .string()
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    provider: providerSchema,
    model: z.string().trim().min(1).max(200),
    effort: reasoningEffortSchema.optional(),
    mode: sessionModeSchema,
    directory: z.string().min(1).max(4096).optional(),
    worktree: z.boolean().optional(),
    title: z.string().min(1).max(1000),
  })
  .refine(value => isProviderSessionMode(value.provider, value.mode), {
    path: ['mode'],
    message: 'Choose a permission mode supported by the provider.',
  });

export const workflowChildReportSchema = z.strictObject({
  status: z.enum([
    'passed',
    'failed',
    'rejected',
    'needs-attention',
    'stopped',
    'interrupted',
    'skipped',
  ]),
  summary: z.string().max(2000),
  links: z.array(z.string().max(2048)).max(8),
  notes: z.array(z.string().max(800)).max(8),
  outputs: z
    .record(z.string().max(64), z.string().max(4000))
    .refine(value => Object.keys(value).length <= 16),
});

export const workflowChildItemSchema = z.strictObject({
  index: z
    .number()
    .int()
    .min(0)
    .max(workflowChildItemLimit - 1),
  title: z.string().min(1).max(100),
  sessionId: z.uuid().nullable(),
  state: z.enum(['waiting', 'starting', 'running', 'finished']),
  reason: z.string().max(800).nullable(),
  report: workflowChildReportSchema.nullable(),
});

export const workflowChildQueueSchema = z
  .array(workflowChildItemSchema)
  .max(workflowChildItemLimit);

export type WorkflowChildSession = z.infer<typeof workflowChildSessionSchema>;
export type WorkflowChildPolicy = z.infer<typeof workflowChildPolicySchema>;
export type WorkflowItemSource = z.infer<typeof workflowItemSourceSchema>;
export type WorkflowItem = z.infer<typeof workflowItemsSchema>[number];
export type WorkflowChildItem = z.infer<typeof workflowChildItemSchema>;
export type WorkflowChildReport = z.infer<typeof workflowChildReportSchema>;
