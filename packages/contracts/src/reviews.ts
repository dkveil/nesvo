import { z } from 'zod';
import { providerSchema } from './sessions';

export const reviewDiffSchema = z.strictObject({
  status: z.enum(['complete', 'unavailable', 'not-applicable']),
  detail: z.string().nullable(),
  patch: z.string().max(200_000),
  files: z
    .array(
      z.strictObject({
        path: z.string().max(4096),
        kind: z.enum(['added', 'modified', 'deleted', 'binary']),
      }),
    )
    .max(500),
  fingerprint: z.string().nullable(),
});
export const reviewSchema = z.strictObject({
  id: z.uuid(),
  sessionId: z.uuid(),
  runId: z.uuid(),
  version: z.number().int().positive(),
  revision: z.number().int().positive(),
  title: z.string(),
  provider: providerSchema,
  role: z.enum(['orchestrator', 'standalone', 'worker']),
  model: z.string(),
  directory: z.string(),
  scope: z.string().nullable(),
  task: z.string().max(32_000),
  summary: z.string().max(2_000_000),
  status: z.enum([
    'pending',
    'accepted',
    'changes-requested',
    'rejected',
    'superseded',
  ]),
  decision: z
    .strictObject({
      id: z.uuid(),
      decision: z.enum(['accept', 'request-changes', 'reject']),
      feedback: z.string().max(8000),
      at: z.iso.datetime(),
    })
    .nullable(),
  dependencies: z
    .array(
      z.strictObject({
        sessionId: z.uuid(),
        reviewId: z.uuid(),
        version: z.number().int().positive(),
      }),
    )
    .max(2),
  diff: reviewDiffSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const decideReviewSchema = z
  .strictObject({
    reviewId: z.uuid(),
    version: z.number().int().positive(),
    decisionId: z.uuid(),
    decision: z.enum(['accept', 'request-changes']),
    feedback: z.string().trim().max(8000).default(''),
  })
  .superRefine((value, context) => {
    if (value.decision === 'request-changes' && !value.feedback)
      context.addIssue({
        code: 'custom',
        message: 'Correction feedback is required',
      });
  });

export type Review = z.infer<typeof reviewSchema>;
export type ReviewDiff = z.infer<typeof reviewDiffSchema>;
export type DecideReviewInput = z.infer<typeof decideReviewSchema>;
