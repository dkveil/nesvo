import { z } from 'zod';

const stepId = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const workflowLaneSchema = z.enum(['light', 'full']);
export const workflowLanesSchema = z.strictObject({
  light: z.strictObject({
    omit: stepId,
    max_changed_files: z.number().int().min(1).max(20).default(5),
    max_changed_lines: z.number().int().min(1).max(500).default(100),
  }),
  full: z.strictObject({}),
});

export const workflowTriageSchema = z.strictObject({
  size: z.enum(['small', 'large', 'unknown']),
  risk: z.enum(['low', 'elevated', 'unknown']),
  area: z.string().trim().min(1).max(120),
  lane: workflowLaneSchema,
  rationale: z.string().trim().min(1).max(600),
});

export const workflowLaneDecisionSchema = z.strictObject({
  requested: workflowLaneSchema.nullable(),
  effective: workflowLaneSchema,
  rationale: z.string().min(1).max(600),
  planMessageId: z.uuid().nullable(),
  review: z
    .strictObject({ id: z.uuid(), version: z.number().int().positive() })
    .optional(),
  assessment: workflowTriageSchema.optional(),
});

export type WorkflowLanes = z.infer<typeof workflowLanesSchema>;
export type WorkflowTriage = z.infer<typeof workflowTriageSchema>;
export type WorkflowLaneDecision = z.infer<typeof workflowLaneDecisionSchema>;
