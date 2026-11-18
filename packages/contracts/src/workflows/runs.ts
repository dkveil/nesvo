import { z } from 'zod';
import { providerSchema } from '../sessions';
import { pullRequestReferenceSchema } from '../pull-requests';
import {
  definitionHashSchema,
  workflowDefinitionLimits,
  resolvedWorkflowSchema,
  stepNameSchema,
  stepPhaseSchema,
  stepTypeSchema,
} from './definitions';
import { stepResultSchema } from './results';

export const workflowLimits = {
  runsPerHost: 200,
  stepsPerRun: workflowDefinitionLimits.workflowSteps,
  evidenceBytesPerStep: 4 * 1024 * 1024,
  finishedRunsPerProject: 100,
  runPage: 100,
  cursor: 512,
  attention: 800,
  skipReason: 800,
  gateModel: 200,
  directory: 4096,
  branch: 200,
  decisionComment: 8000,
  definitionChanges: 64,
} as const;

export const workflowRunStatusSchema = z.enum([
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

export const workflowStepStateSchema = z.enum([
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
const directorySchema = z.string().max(workflowLimits.directory);

export const workflowStepDecisionKindSchema = z.enum([
  'accept',
  'reject',
  'fix',
  'mark-done',
  'run-again',
]);

export const workflowStepDecisionSchema = z.strictObject({
  decisionId: idSchema,
  kind: workflowStepDecisionKindSchema,
  comment: z.string().max(workflowLimits.decisionComment),
  at: z.iso.datetime(),
});

export const workflowIsolationSchema = z.strictObject({
  worktree: z.string().min(1).max(workflowLimits.directory),
  branch: z.string().min(1).max(workflowLimits.branch),
  base: z.string().min(1).max(workflowLimits.branch),
});

export const workflowRunSchema = z.strictObject({
  id: idSchema,
  revision: revisionSchema,
  workflow: resolvedWorkflowSchema,
  specPath: z.string().min(1).max(workflowLimits.directory),
  specHash: definitionHashSchema,
  specTitle: z.string().min(1).max(workflowDefinitionLimits.specTitle),
  sessionId: idSchema.nullable(),
  directory: directorySchema,
  projectRoot: z.string().min(1).max(workflowLimits.directory),
  isolation: workflowIsolationSchema.nullable(),
  gateProvider: providerSchema,
  gateModel: z.string().min(1).max(workflowLimits.gateModel),
  status: workflowRunStatusSchema,
  phase: stepPhaseSchema.nullable(),
  currentStepIndex: z
    .number()
    .int()
    .min(0)
    .max(workflowLimits.stepsPerRun - 1)
    .nullable(),
  attention: z.string().max(workflowLimits.attention).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime({ precision: 3 }),
  finishedAt: z.iso.datetime().nullable(),
});

const ciWaitSchema = z.strictObject({
  reference: pullRequestReferenceSchema,
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

export type WorkflowCiWait = z.infer<typeof ciWaitSchema>;

export const workflowStepRecordSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  revision: revisionSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(workflowLimits.stepsPerRun - 1),
  name: stepNameSchema,
  type: stepTypeSchema,
  phase: stepPhaseSchema,
  state: workflowStepStateSchema,
  attempt: z.number().int().nonnegative(),
  retry: z
    .number()
    .int()
    .min(0)
    .max(workflowDefinitionLimits.retries)
    .optional(),
  retryAt: z.iso.datetime().optional(),
  ciWait: ciWaitSchema.optional(),
  result: stepResultSchema.nullable(),
  sessionId: idSchema.nullable(),
  reviewId: idSchema.nullable(),
  reviewVersion: z.number().int().positive().nullable(),
  skip: z
    .strictObject({
      reason: z.string().min(1).max(workflowLimits.skipReason),
      at: z.iso.datetime(),
    })
    .nullable(),
  updatedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  decision: workflowStepDecisionSchema.nullable().default(null),
  definitionChanges: z
    .array(z.string().min(1).max(workflowLimits.directory))
    .max(workflowLimits.definitionChanges)
    .default([]),
});

export const workflowRunPageSchema = z.strictObject({
  runs: z.array(workflowRunSchema).max(workflowLimits.runPage),
  nextCursor: z.string().min(1).max(workflowLimits.cursor).nullable(),
});

export const workflowRunDetailSchema = z.strictObject({
  run: workflowRunSchema,
  steps: z.array(workflowStepRecordSchema),
});

export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export type WorkflowStepState = z.infer<typeof workflowStepStateSchema>;
export type WorkflowStepDecisionKind = z.infer<
  typeof workflowStepDecisionKindSchema
>;
export type WorkflowStepDecision = z.infer<typeof workflowStepDecisionSchema>;
export type WorkflowIsolation = z.infer<typeof workflowIsolationSchema>;
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowStepRecord = z.infer<typeof workflowStepRecordSchema>;
export type WorkflowRunPage = z.infer<typeof workflowRunPageSchema>;
export type WorkflowRunDetail = z.infer<typeof workflowRunDetailSchema>;
