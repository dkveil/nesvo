import { z } from 'zod';
import { autonomyLevelSchema } from './autonomy';
import { definitionHashSchema, stepNameSchema } from './definitions';
import { githubRepositorySchema } from '../pull-requests';
import { workflowLaneSchema } from './lanes';

export const gatePolicySchema = z.strictObject({
  version: z.literal(1),
  mode: z.enum(['observe', 'enabled']).default('observe'),
  repository: githubRepositorySchema,
  workflow: stepNameSchema,
  gate: stepNameSchema,
  lanes: z.array(workflowLaneSchema).min(1).max(2),
  target_branches: z.array(z.string().min(1).max(200)).min(1).max(20),
  requires: z.strictObject({
    ci: z.literal('green'),
    checks: z.array(stepNameSchema).min(1).max(16),
  }),
  protected_paths: z.array(z.string().min(1).max(240)).max(32),
  max_changed_files: z.number().int().min(1).max(100),
  max_changed_lines: z.number().int().min(1).max(1000),
  allow: z
    .array(z.enum(['accept-result', 'submit-review', 'squash-merge']))
    .max(3)
    .default([]),
});

export const gateRecommendationOutputSchema = z.strictObject({
  recommendation: z.enum(['approve', 'escalate']),
  reason: z.string().trim().min(1).max(600),
  references: z.array(stepNameSchema).max(16),
  uncertainPaths: z.array(z.string().min(1).max(4096)).max(100).optional(),
});

export const gateRecommendationSchema = z.strictObject({
  outcome: z.enum(['would-approve', 'needs-approval']),
  reason: z.string().min(1).max(800),
  policy: stepNameSchema.optional(),
  level: autonomyLevelSchema.optional(),
  precedents: z.array(stepNameSchema).max(4).optional(),
  narrowedPaths: z.array(z.string().min(1).max(4096)).max(100).optional(),
  policyHash: definitionHashSchema.optional(),
  head: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  report: gateRecommendationOutputSchema.optional(),
});

export type GatePolicy = z.infer<typeof gatePolicySchema>;
export type GateRecommendation = z.infer<typeof gateRecommendationSchema>;
export type GateRecommendationOutput = z.infer<
  typeof gateRecommendationOutputSchema
>;
