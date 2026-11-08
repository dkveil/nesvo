import { z } from 'zod';
import { providerSchema } from './sessions';

export const providerUsageInputSchema = z.strictObject({
  provider: providerSchema,
});
export type ProviderUsageInput = z.infer<typeof providerUsageInputSchema>;

export const providerUsageSchema = z.strictObject({
  provider: providerSchema,
  status: z.enum(['ready', 'unavailable', 'unauthenticated', 'error']),
  account: z
    .strictObject({
      label: z.string().max(320).nullable(),
      plan: z.string().max(100).nullable(),
    })
    .nullable(),
  windows: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        label: z.string().min(1).max(200),
        usedPercent: z.number().min(0).max(10000),
        resetsAt: z.iso.datetime().nullable(),
        windowMinutes: z.number().int().positive().nullable(),
      }),
    )
    .max(32),
  checkedAt: z.iso.datetime(),
  source: z.enum(['codex-app-server', 'claude-control']).nullable(),
  ordinaryUsageAllowed: z.boolean().nullable(),
  detail: z.string().max(1000).nullable(),
});
export type ProviderUsage = z.infer<typeof providerUsageSchema>;
