import { z } from 'zod';

export const reasoningEffortSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/, 'Unsupported reasoning effort');
export const reasoningEffortOptionSchema = z.strictObject({
  id: reasoningEffortSchema,
  description: z.string().max(500),
});
export const modelEffortsSchema = z
  .strictObject({
    options: z.array(reasoningEffortOptionSchema).min(1).max(16),
    defaultEffort: reasoningEffortSchema,
  })
  .refine(
    value =>
      value.options.some(option => option.id === value.defaultEffort) &&
      new Set(value.options.map(option => option.id)).size ===
        value.options.length,
    'The default reasoning effort must be one of the unique options',
  );
export const effortSupportSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('per-model') }),
  z.strictObject({
    status: z.literal('unsupported'),
    reason: z.string().trim().min(1).max(500),
  }),
]);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type ReasoningEffortOption = z.infer<typeof reasoningEffortOptionSchema>;
export type ModelEfforts = z.infer<typeof modelEffortsSchema>;
export type EffortSupport = z.infer<typeof effortSupportSchema>;
