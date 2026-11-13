import { z } from 'zod';
import { providerSchema } from '../sessions';
import {
  pipelineDefinitionLimits,
  stepNameSchema,
  stepPhaseSchema,
  stepTypeSchema,
} from './definitions';

export const pipelineMetricsLimits = {
  gates: 200,
  runsPerQuery: 1000,
} as const;

const countSchema = z.number().int().nonnegative();
const rateSchema = z.number().min(0).max(1);
const durationMsSchema = z.number().nonnegative();
const usdSchema = z.number().nonnegative();

export const pipelineMetricsInputSchema = z.strictObject({
  directory: z
    .string()
    .trim()
    .max(pipelineDefinitionLimits.path)
    .nullable()
    .default(null),
  since: z.iso.datetime(),
});

export const pipelineGateMetricsSchema = z.strictObject({
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

export const pipelineProviderCostSchema = z.strictObject({
  provider: providerSchema,
  usd: usdSchema.nullable(),
  inputTokens: countSchema.nullable(),
  outputTokens: countSchema.nullable(),
});

export const pipelineMetricsSchema = z.strictObject({
  since: z.iso.datetime(),
  until: z.iso.datetime(),
  scope: z.strictObject({
    directory: z.string().max(pipelineDefinitionLimits.path).nullable(),
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
  gates: z.array(pipelineGateMetricsSchema).max(pipelineMetricsLimits.gates),
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
      .array(pipelineProviderCostSchema)
      .max(providerSchema.options.length),
  }),
});

export type PipelineMetricsInput = z.input<typeof pipelineMetricsInputSchema>;
export type PipelineGateMetrics = z.infer<typeof pipelineGateMetricsSchema>;
export type PipelineProviderCost = z.infer<typeof pipelineProviderCostSchema>;
export type PipelineMetrics = z.infer<typeof pipelineMetricsSchema>;
