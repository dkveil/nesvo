import { z } from 'zod';

export const activityLimits = {
  items: 300,
  perRun: 100,
  detail: 2000,
  output: 4000,
  paths: 10,
  pathLength: 1024,
} as const;

export const sessionActivitySchema = z.strictObject({
  id: z.string().min(1).max(200),
  runId: z.uuid(),
  kind: z.enum(['command', 'file-change', 'read', 'search', 'tool']),
  title: z.string().min(1).max(200),
  status: z.enum([
    'running',
    'completed',
    'failed',
    'declined',
    'stopped',
    'interrupted',
  ]),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  detail: z.string().max(activityLimits.detail).nullable(),
  output: z.string().max(activityLimits.output),
  paths: z
    .array(z.string().max(activityLimits.pathLength))
    .max(activityLimits.paths),
  truncated: z.boolean(),
});

export type SessionActivity = z.infer<typeof sessionActivitySchema>;
