import { z } from 'zod';
import { providerSchema } from '../sessions';
import {
  workflowDefinitionLimits,
  stepNameSchema,
  stepPhaseSchema,
  stepTypeSchema,
} from './definitions';

export const workflowMetricsLimits = {
  gates: 200,
  runsPerQuery: 1000,
} as const;

const countSchema = z.number().int().nonnegative();
const rateSchema = z.number().min(0).max(1);
const durationMsSchema = z.number().nonnegative();
const usdSchema = z.number().nonnegative();

export const workflowMetricsInputSchema = z.strictObject({
  directory: z
    .string()
    .trim()
    .max(workflowDefinitionLimits.path)
    .nullable()
    .default(null),
  since: z.iso.datetime(),
});

export const workflowGateMetricsSchema = z.strictObject({
  name: stepNameSchema,
  type: stepTypeSchema,
  phase: stepPhaseSchema,
  runs: countSchema,
  passedFirst: countSchema,
  failed: countSchema,
  blocked: countSchema,
  skipped: countSchema,
  meanDurationMs: durationMsSchema.nullable(),
  catchRate: rateSchema,
});

export const workflowProviderCostSchema = z.strictObject({
  provider: providerSchema,
  usd: usdSchema.nullable(),
  inputTokens: countSchema.nullable(),
  outputTokens: countSchema.nullable(),
});

export const workflowMetricsSchema = z.strictObject({
  since: z.iso.datetime(),
  until: z.iso.datetime(),
  scope: z.strictObject({
    directory: z.string().max(workflowDefinitionLimits.path).nullable(),
  }),
  tasks: z.strictObject({
    started: countSchema,
    passed: countSchema,
    failed: countSchema,
    rejected: countSchema,
    needsAttention: countSchema,
    stopped: countSchema,
    interrupted: countSchema,
  }),
  firstPassRate: z.strictObject({
    gates: rateSchema.nullable(),
    tasks: rateSchema.nullable(),
  }),
  gates: z.array(workflowGateMetricsSchema).max(workflowMetricsLimits.gates),
  correctionsAfterAcceptance: z.strictObject({
    count: countSchema,
    tasks: countSchema,
  }),
  timeToAcceptance: z.strictObject({
    medianMs: durationMsSchema.nullable(),
    p90Ms: durationMsSchema.nullable(),
    samples: countSchema,
  }),
  timeToFirstLink: z.strictObject({
    medianMs: durationMsSchema.nullable(),
    samples: countSchema,
  }),
  cost: z.strictObject({
    usd: usdSchema.nullable(),
    inputTokens: countSchema.nullable(),
    outputTokens: countSchema.nullable(),
    perTaskMedianUsd: usdSchema.nullable(),
    providers: z
      .array(workflowProviderCostSchema)
      .max(providerSchema.options.length),
  }),
});

export type WorkflowMetricsInput = z.input<typeof workflowMetricsInputSchema>;
export type WorkflowGateMetrics = z.infer<typeof workflowGateMetricsSchema>;
export type WorkflowProviderCost = z.infer<typeof workflowProviderCostSchema>;
export type WorkflowMetrics = z.infer<typeof workflowMetricsSchema>;
