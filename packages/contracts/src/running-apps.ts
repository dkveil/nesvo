import { z } from 'zod';

export const runningAppLimits = {
  apps: 256,
  nameLength: 255,
} as const;

export const runningAppMatchSchema = z.enum(['process', 'folder']);

export const runningAppSchema = z.strictObject({
  port: z.number().int().min(1).max(65_535),
  address: z.string().max(64),
  pid: z.number().int().positive(),
  name: z.string().max(runningAppLimits.nameLength),
  sessionId: z.string().min(1).max(200),
  match: runningAppMatchSchema,
});

export const runningAppListSchema = z.strictObject({
  apps: z.array(runningAppSchema).max(runningAppLimits.apps),
  observedAt: z.iso.datetime(),
});

export type RunningAppMatch = z.infer<typeof runningAppMatchSchema>;
export type RunningApp = z.infer<typeof runningAppSchema>;
export type RunningAppList = z.infer<typeof runningAppListSchema>;
