import { z } from 'zod';
import { providerSchema } from '../sessions';
import {
  definitionHashSchema,
  pipelineDefinitionLimits,
  resolvedPipelineSchema,
  stepNameSchema,
  stepPhaseSchema,
  stepTypeSchema,
} from './definitions';
import { stepResultSchema } from './results';

export const pipelineLimits = {
  runsPerHost: 200,
  stepsPerRun: pipelineDefinitionLimits.pipelineSteps,
  evidenceBytesPerStep: 4 * 1024 * 1024,
  finishedRunsPerProject: 100,
  runPage: 100,
  cursor: 512,
  attention: 800,
  skipReason: 800,
  gateModel: 200,
  directory: 4096,
  branch: 200,
} as const;

export const pipelineRunStatusSchema = z.enum([
  'pending',
  'planning',
  'implementing',
  'checking',
  'awaiting-human',
  'fixing',
  'passed',
  'failed',
  'rejected',
  'needs-attention',
  'stopped',
  'interrupted',
]);

export const pipelineStepStateSchema = z.enum([
  'pending',
  'running',
  'awaiting-human',
  'passed',
  'failed',
  'blocked',
  'done',
  'error',
  'skipped',
  'interrupted',
  'uncertain',
  'unreached',
]);

const idSchema = z.uuid();
const revisionSchema = z.number().int().positive();
const directorySchema = z.string().max(pipelineLimits.directory);

export const pipelineIsolationSchema = z.strictObject({
  worktree: z.string().min(1).max(pipelineLimits.directory),
  branch: z.string().min(1).max(pipelineLimits.branch),
  base: z.string().min(1).max(pipelineLimits.branch),
});

export const pipelineRunSchema = z.strictObject({
  id: idSchema,
  revision: revisionSchema,
  pipeline: resolvedPipelineSchema,
  specPath: z.string().min(1).max(pipelineLimits.directory),
  specHash: definitionHashSchema,
  specTitle: z.string().min(1).max(pipelineDefinitionLimits.specTitle),
  sessionId: idSchema.nullable(),
  directory: directorySchema,
  projectRoot: z.string().min(1).max(pipelineLimits.directory),
  isolation: pipelineIsolationSchema.nullable(),
  gateProvider: providerSchema,
  gateModel: z.string().min(1).max(pipelineLimits.gateModel),
  status: pipelineRunStatusSchema,
  phase: stepPhaseSchema.nullable(),
  currentStepIndex: z
    .number()
    .int()
    .min(0)
    .max(pipelineLimits.stepsPerRun - 1)
    .nullable(),
  attention: z.string().max(pipelineLimits.attention).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime({ precision: 3 }),
  finishedAt: z.iso.datetime().nullable(),
});

export const pipelineStepRecordSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  revision: revisionSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(pipelineLimits.stepsPerRun - 1),
  name: stepNameSchema,
  type: stepTypeSchema,
  phase: stepPhaseSchema,
  state: pipelineStepStateSchema,
  attempt: z.number().int().nonnegative(),
  result: stepResultSchema.nullable(),
  sessionId: idSchema.nullable(),
  reviewId: idSchema.nullable(),
  reviewVersion: z.number().int().positive().nullable(),
  skip: z
    .strictObject({
      reason: z.string().min(1).max(pipelineLimits.skipReason),
      at: z.iso.datetime(),
    })
    .nullable(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
});

export const pipelineRunPageSchema = z.strictObject({
  runs: z.array(pipelineRunSchema).max(pipelineLimits.runPage),
  nextCursor: z.string().min(1).max(pipelineLimits.cursor).nullable(),
});

export const pipelineRunDetailSchema = z.strictObject({
  run: pipelineRunSchema,
  steps: z.array(pipelineStepRecordSchema).max(pipelineLimits.stepsPerRun),
});

export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;
export type PipelineStepState = z.infer<typeof pipelineStepStateSchema>;
export type PipelineIsolation = z.infer<typeof pipelineIsolationSchema>;
export type PipelineRun = z.infer<typeof pipelineRunSchema>;
export type PipelineStepRecord = z.infer<typeof pipelineStepRecordSchema>;
export type PipelineRunPage = z.infer<typeof pipelineRunPageSchema>;
export type PipelineRunDetail = z.infer<typeof pipelineRunDetailSchema>;
