import { z } from 'zod';
import { providerUsageInputSchema } from './provider-usage';

export const providerUsagePolicySchema = providerUsageInputSchema.extend({
  policy: z.enum(['warn', 'hold']),
  threshold: z.number().min(0).max(100),
  onUnavailable: z.enum(['warn', 'hold']).default('warn'),
  windows: z.array(z.string().min(1).max(200)).max(32).default([]),
});

export const providerUsageEvidenceSchema = z.strictObject({
  state: z.enum(['allowed', 'warning', 'held']),
  reason: z.string().max(1000).nullable(),
  sampledAt: z.iso.datetime().nullable(),
  resetsAt: z.iso.datetime().nullable(),
  windowId: z.string().max(200).nullable(),
  usedPercent: z.number().min(0).max(10000).nullable(),
});

export const providerUsageHoldSchema = providerUsageInputSchema.extend({
  id: z.uuid(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['create', 'turn']),
  title: z.string().max(100),
  sessionId: z.uuid().nullable(),
  model: z.string().max(200),
  createdAt: z.iso.datetime(),
  status: z.enum(['held', 'ready', 'cancelled', 'dispatched']),
  evidence: providerUsageEvidenceSchema,
});

const actionId = z.uuid();
export const providerUsageGateInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({
    action: z.literal('save'),
    actionId,
    policy: providerUsagePolicySchema,
  }),
  z.strictObject({
    action: z.literal('remove'),
    actionId,
    target: providerUsageInputSchema,
  }),
  z.strictObject({ action: z.literal('check'), actionId, holdId: z.uuid() }),
  z.strictObject({ action: z.literal('cancel'), actionId, holdId: z.uuid() }),
]);

export const providerUsageGateSettingsSchema = z.strictObject({
  policies: z.array(providerUsagePolicySchema).max(100),
  holds: z.array(providerUsageHoldSchema).max(100),
  history: z
    .array(
      z.strictObject({
        id: z.uuid(),
        action: z.enum([
          'save',
          'remove',
          'check',
          'cancel',
          'hold',
          'dispatch',
          'warn',
          'provider-rejected',
        ]),
        hostId: z.uuid(),
        actor: z.enum(['operator', 'host', 'provider']),
        target: providerUsageInputSchema,
        holdId: z.uuid().nullable(),
        at: z.iso.datetime(),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(100),
});

export type ProviderUsagePolicy = z.infer<typeof providerUsagePolicySchema>;
export type ProviderUsageHold = z.infer<typeof providerUsageHoldSchema>;
export type ProviderUsageEvidence = z.infer<typeof providerUsageEvidenceSchema>;
export type ProviderUsageGateInput = z.infer<
  typeof providerUsageGateInputSchema
>;
export type ProviderUsageGateSettings = z.infer<
  typeof providerUsageGateSettingsSchema
>;
