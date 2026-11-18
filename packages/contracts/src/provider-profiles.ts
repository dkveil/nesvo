import { z } from 'zod';
import { providerSchema } from './sessions';

export const providerProfileSelectionSchema = z.strictObject({
  profileId: z.uuid().nullable().optional(),
});

export const createProviderProfileSchema = z.strictObject({
  provider: providerSchema,
  label: z.string().trim().min(1).max(80),
  configDirectory: z.string().trim().min(1).max(4096),
});

export const providerProfileSchema = createProviderProfileSchema.extend({
  id: z.uuid(),
});

export const providerProfileListSchema = z.array(providerProfileSchema).max(64);

export const removeProviderProfileSchema = z.strictObject({
  profileId: z.uuid(),
});

export const renameProviderProfileSchema = removeProviderProfileSchema.extend({
  label: createProviderProfileSchema.shape.label,
});

export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type ProviderProfileSelection = z.infer<
  typeof providerProfileSelectionSchema
>;
export type CreateProviderProfileInput = z.infer<
  typeof createProviderProfileSchema
>;
export type RenameProviderProfileInput = z.infer<
  typeof renameProviderProfileSchema
>;
