import { z } from 'zod';

export const workLaptopPolicySchema = z.strictObject({
  enabled: z.boolean(),
  requested: z.boolean(),
  enforced: z.boolean(),
  automaticallyEnabled: z.boolean(),
});
export type WorkLaptopPolicy = z.infer<typeof workLaptopPolicySchema>;

export const workLaptopRestriction =
  'Work laptop mode blocks Phone access and remote computers.';

export const retentionDaysSchema = z.number().int().min(1).max(3650).nullable();
export const transcriptRetentionSchema = z.strictObject({
  days: retentionDaysSchema,
  purgedSessions: z.number().int().nonnegative(),
});
export type TranscriptRetention = z.infer<typeof transcriptRetentionSchema>;

export const deleteLocalDataPhrase = 'DELETE ALL NESVO DATA';
