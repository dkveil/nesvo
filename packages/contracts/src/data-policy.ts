import { z } from 'zod';

export const retentionDaysSchema = z.number().int().min(1).max(3650).nullable();
export const transcriptRetentionSchema = z.strictObject({
  days: retentionDaysSchema,
  purgedSessions: z.number().int().nonnegative(),
});
export type TranscriptRetention = z.infer<typeof transcriptRetentionSchema>;
