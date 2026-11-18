import { z } from 'zod';

const directorySchema = z.string().trim().min(1).max(4096);
export const chooseDirectoryResultSchema = directorySchema.nullable();
export const onboardingOpenSchema = z.boolean();
export const reviewWorkingRulesSchema = z.strictObject({
  provider: z.enum(['Claude Code', 'Codex']),
  model: z.string().trim().min(1).max(200),
  directory: directorySchema.or(z.literal('')),
});
export const workingRulesReviewSchema = z.strictObject({
  summary: z.string().min(1).max(4000),
  sources: z.array(z.string().min(1).max(512)).max(16),
  limited: z.boolean(),
});
export type ReviewWorkingRulesInput = z.infer<typeof reviewWorkingRulesSchema>;
export type WorkingRulesReview = z.infer<typeof workingRulesReviewSchema>;
