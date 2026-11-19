import { z } from 'zod';
import { autonomyTargetSchema } from './autonomy';
import { stepNameSchema } from './definitions';
import { workflowLaneSchema } from './lanes';

const evidenceHash = z.string().regex(/^[a-f0-9]{64}$/);
const laneCondition = z.enum(['lane == "light"', 'lane == "full"']);
const pathPrefix = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.@ -]+(?:\/[a-zA-Z0-9_.@ -]+)*$/)
  .refine(path => path.split('/').every(part => part !== '..' && part !== '.'));

export const gateTrustConditionSchema = z.strictObject({
  when: laneCondition,
  maximumFiles: z.number().int().min(1).max(50),
  maximumLines: z.number().int().min(1).max(500),
  passedChecks: z.array(stepNameSchema).min(1).max(12),
  protectedPaths: z.array(pathPrefix).max(24),
});
export type GateTrustCondition = z.infer<typeof gateTrustConditionSchema>;

export const gateTrustRecordSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  reasons: z.string().trim().max(2000),
  humanRequired: z.boolean(),
  split: z
    .strictObject({
      definition: evidenceHash,
      evidence: evidenceHash,
      condition: gateTrustConditionSchema,
    })
    .nullable(),
  dismissed: evidenceHash.nullable(),
});
export type GateTrustRecord = z.infer<typeof gateTrustRecordSchema>;

const gateTrustCaseSchema = z.strictObject({
  runId: z.uuid(),
  sessionId: z.uuid().nullable(),
  stepId: z.uuid(),
  at: z.iso.datetime(),
  safe: z.boolean(),
  decision: z.enum(['accept', 'fix', 'reject']),
  stage: z.enum(['plan', 'pre-done', 'pre-push']),
  lane: workflowLaneSchema.nullable(),
  risk: z.enum(['low', 'elevated', 'unknown']),
  paths: z.array(z.string().max(300)).max(12),
  files: z.number().int().nonnegative().nullable(),
  lines: z.number().int().nonnegative().nullable(),
  checks: z.array(stepNameSchema).max(12),
  concerns: z.array(z.enum(['diff', 'checks', 'risk', 'override'])).max(4),
});
export type GateTrustCase = z.infer<typeof gateTrustCaseSchema>;

export const gateTrustViewSchema = z.strictObject({
  definition: evidenceHash,
  record: gateTrustRecordSchema,
  cases: z.array(gateTrustCaseSchema).max(50),
  current: z.boolean(),
  memoryEnabled: z.boolean(),
  proposal: z
    .strictObject({
      evidence: evidenceHash,
      findings: z.array(z.string().max(300)).max(10),
      candidate: gateTrustConditionSchema.nullable(),
      condition: gateTrustConditionSchema.nullable(),
      trusted: z.number().int().nonnegative(),
      human: z.number().int().nonnegative(),
    })
    .optional(),
});
export type GateTrustView = z.infer<typeof gateTrustViewSchema>;

const trustUpdate = {
  target: autonomyTargetSchema,
  revision: gateTrustRecordSchema.shape.revision,
};

export const gateTrustReadSchema = z.strictObject({
  action: z.literal('trust-read'),
  target: autonomyTargetSchema,
});
export const gateTrustAskSchema = z.strictObject({
  action: z.literal('trust-ask'),
  target: autonomyTargetSchema,
});
export const gateTrustSaveSchema = z.strictObject({
  action: z.literal('trust-save'),
  ...trustUpdate,
  reasons: gateTrustRecordSchema.shape.reasons,
  humanRequired: z.boolean(),
  clearSplit: z.boolean().optional(),
});
export const gateTrustDecisionSchema = z.strictObject({
  action: z.literal('trust-decide'),
  ...trustUpdate,
  evidence: evidenceHash,
  definition: evidenceHash,
  decision: z.enum(['accept', 'dismiss', 'preview']),
  condition: gateTrustConditionSchema.optional(),
});
export type GateTrustRequest = z.infer<
  | typeof gateTrustReadSchema
  | typeof gateTrustAskSchema
  | typeof gateTrustSaveSchema
  | typeof gateTrustDecisionSchema
>;
