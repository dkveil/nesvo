import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const target = z
  .string()
  .max(120)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/);
const gradleTask = z
  .string()
  .max(120)
  .regex(/^:?[a-zA-Z0-9][\w.-]*(?::[a-zA-Z0-9][\w.-]*)*$/);
const source = z.strictObject({
  file: z.string().min(1).max(240),
  location: z.string().min(1).max(300),
  hash,
});

export const checkIntentSchema = z.enum(['tests']);
export const checkStackSchema = z.enum(['typescript', 'kotlin']);
const packageScriptSchema = z.strictObject({
  runner: z.literal('package-script'),
  script: target,
});
const gradleTargetSchema = z.strictObject({
  runner: z.literal('gradle-wrapper'),
  task: gradleTask,
});
export const checkPreferencesSchema = z.strictObject({
  typescript: packageScriptSchema.optional(),
  kotlin: gradleTargetSchema.optional(),
});

const invocation = z.strictObject({
  tool: z.string().min(1).max(120),
  args: z.array(z.string().min(1).max(200)).max(24),
});
export const projectCheckSchema = z.union([
  packageScriptSchema,
  gradleTargetSchema,
  z.strictObject({
    runner: z.literal('command'),
    command: z.string().min(1).max(600),
    source,
  }),
]);
export const projectCheckOverrideSchema = z.strictObject({
  stack: checkStackSchema.optional(),
  module: z
    .string()
    .max(160)
    .regex(/^[\w-]+(?:\/[\w-]+)*$/)
    .optional(),
  checks: z.strictObject({ tests: projectCheckSchema.optional() }).optional(),
});

export const checkCandidateSchema = z.strictObject({
  id: hash,
  intent: checkIntentSchema,
  coverage: z.string().min(1).max(120),
  target: z.union([packageScriptSchema, gradleTargetSchema, invocation]),
  directory: z.string().min(1).max(160),
  source,
  availability: z.enum(['available', 'missing', 'unverified']),
  reason: z.string().max(500).nullable(),
});
export const checkProjectProfileSchema = z.strictObject({
  stack: z.enum(['typescript', 'kotlin', 'ambiguous', 'unknown']),
  directory: z.string().min(1).max(160),
  hash,
  overrideHash: hash.nullable(),
  issue: z.string().max(500).nullable(),
  candidates: z.array(checkCandidateSchema).max(48),
});

export const checkResolutionSchema = z
  .strictObject({
    candidateId: hash.nullable(),
    proposal: z
      .strictObject({
        command: z.string().min(1).max(600),
        sourceFile: z.string().min(1).max(160),
        location: z.string().min(1).max(300),
      })
      .nullable(),
    rationale: z.string().trim().min(1).max(600),
  })
  .refine(value => value.candidateId === null || value.proposal === null);

export const checkEvidenceSchema = z.strictObject({
  profileHash: hash,
  proposed: checkCandidateSchema.nullable(),
  rationale: z.string().max(600).nullable(),
  resultVersion: z
    .strictObject({ id: z.uuid(), version: z.number().int().positive() })
    .optional(),
  mapping: z
    .strictObject({
      conversationId: z.uuid(),
      changeId: z.uuid(),
    })
    .optional(),
  invocations: z
    .array(
      z.strictObject({
        candidate: checkCandidateSchema,
        command: z.string().max(1200).nullable(),
        head: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .nullable(),
        mode: z.string().max(50),
        substitution: z.string().max(600).nullable(),
        outcome: z.enum([
          'setup-mismatch',
          'blocked',
          'passed',
          'failed',
          'timeout',
        ]),
        exitCode: z.number().int().nullable(),
        proof: z.string().max(600).nullable(),
        reason: z.string().max(600),
        startedAt: z.iso.datetime(),
        finishedAt: z.iso.datetime(),
      }),
    )
    .max(2),
});

export type CheckCandidate = z.infer<typeof checkCandidateSchema>;
export type CheckProjectProfile = z.infer<typeof checkProjectProfileSchema>;
export type CheckEvidence = z.infer<typeof checkEvidenceSchema>;
export type CheckResolution = z.infer<typeof checkResolutionSchema>;
export type ProjectCheckOverride = z.infer<typeof projectCheckOverrideSchema>;
