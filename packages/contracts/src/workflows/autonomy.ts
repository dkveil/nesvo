import { z } from 'zod';
import { stepNameSchema } from './definitions';

export const autonomyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

export const autonomyTargetSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  workflow: stepNameSchema,
  gate: stepNameSchema,
});

export const autonomySettingsSchema = z.strictObject({
  revision: z.number().int().min(0),
  level: autonomyLevelSchema,
  minimum: z.number().int().min(1).max(100),
  windowDays: z.number().int().min(1).max(365),
  override: z
    .strictObject({
      stepId: z.uuid(),
      reason: z.string().trim().min(1).max(1000),
      at: z.iso.datetime(),
    })
    .optional(),
});
export type AutonomySettings = z.infer<typeof autonomySettingsSchema>;
export const autonomyStatisticsSchema = z.strictObject({
  settings: autonomySettingsSchema,
  observations: z.number().int().nonnegative(),
  agreements: z.number().int().nonnegative(),
  overrides: z.number().int().nonnegative(),
  proposal: autonomyLevelSchema.nullable(),
  considerNarrowing: z.boolean(),
});
export type AutonomyStatistics = z.infer<typeof autonomyStatisticsSchema>;
export type AutonomyTarget = z.infer<typeof autonomyTargetSchema>;

export const autonomySettingsInputSchema = z.strictObject({
  target: autonomyTargetSchema,
  revision: z.number().int().nonnegative(),
  level: autonomyLevelSchema,
  minimum: autonomySettingsSchema.shape.minimum,
  windowDays: autonomySettingsSchema.shape.windowDays,
  confirmed: z.literal(true),
});
export type AutonomySettingsInput = z.infer<typeof autonomySettingsInputSchema>;

export const overrideGatePolicySchema = z.strictObject({
  runId: z.uuid(),
  stepId: z.uuid(),
  overrideId: z.uuid(),
  reason: z.string().trim().min(1).max(1000),
});
export type OverrideGatePolicyInput = z.infer<typeof overrideGatePolicySchema>;
