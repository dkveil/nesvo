import { z } from 'zod';
import { reasoningEffortSchema } from '../reasoning-effort';
import {
  claudeModelSchema,
  providerSchema,
  sessionModeSchema,
} from '../sessions';
import {
  definitionKindSchema,
  definitionScopeSchema,
  pipelineDefinitionLimits,
  stepNameSchema,
  stepPhaseSchema,
} from './definitions';
import { pipelineLimits } from './runs';

export const pipelineCommandLimits = {
  title: pipelineDefinitionLimits.specTitle,
  model: 200,
  comment: 8000,
  document: 65_536,
  evidencePath: 1024,
  evidencePreviewBytes: 262_144,
} as const;

const idSchema = z.uuid();
const directorySchema = z.string().trim().max(pipelineDefinitionLimits.path);
const specPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(pipelineDefinitionLimits.path)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const modelSchema = z.string().trim().min(1).max(pipelineCommandLimits.model);

export const listPipelineDefinitionsSchema = z.strictObject({
  directory: directorySchema,
});

export const validatePipelineDefinitionsSchema = listPipelineDefinitionsSchema;

export const startPipelineTaskSchema = z
  .strictObject({
    specPath: specPathSchema,
    pipelineName: stepNameSchema,
    title: z.string().trim().min(1).max(pipelineCommandLimits.title).optional(),
    provider: providerSchema,
    model: modelSchema,
    effort: reasoningEffortSchema.optional(),
    mode: sessionModeSchema,
    directory: directorySchema,
    isolation: z.enum(['none', 'worktree']),
    gateProvider: providerSchema,
    gateModel: modelSchema,
  })
  .superRefine((value, context) => {
    if (
      value.provider === 'Claude Code' &&
      (value.mode !== 'read-only' ||
        !claudeModelSchema.safeParse(value.model).success)
    )
      context.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Unsupported Claude Code model or mode',
      });
    if (
      value.effort &&
      (value.provider === 'Claude Code' || value.model === 'default')
    )
      context.addIssue({
        code: 'custom',
        path: ['effort'],
        message:
          value.provider === 'Claude Code'
            ? 'Claude Code sessions do not accept a reasoning effort'
            : 'Choose a specific Codex model to set a reasoning effort',
      });
    if (
      value.gateProvider === 'Claude Code' &&
      !claudeModelSchema.safeParse(value.gateModel).success
    )
      context.addIssue({
        code: 'custom',
        path: ['gateModel'],
        message: 'Unsupported Claude Code gate model',
      });
  });

export const runPipelineStepsSchema = z.strictObject({
  specPath: specPathSchema,
  directory: directorySchema,
  phase: stepPhaseSchema.optional(),
});

export const listPipelineRunsSchema = z.strictObject({
  cursor: z.string().min(1).max(pipelineLimits.cursor).nullable().default(null),
  limit: z.number().int().min(1).max(pipelineLimits.runPage).default(20),
});

export const pipelineRunReferenceSchema = z.strictObject({ runId: idSchema });
export const getPipelineRunSchema = pipelineRunReferenceSchema;
export const resumePipelineRunSchema = pipelineRunReferenceSchema;
export const stopPipelineRunSchema = pipelineRunReferenceSchema;
export const removePipelineWorktreeSchema = pipelineRunReferenceSchema;

export const decidePipelineGateSchema = z
  .strictObject({
    runId: idSchema,
    stepId: idSchema,
    reviewId: idSchema,
    version: z.number().int().positive(),
    decisionId: idSchema,
    decision: z.enum(['accept', 'reject', 'fix']),
    comment: z.string().trim().max(pipelineCommandLimits.comment).default(''),
  })
  .superRefine((value, context) => {
    if (value.decision !== 'accept' && !value.comment)
      context.addIssue({
        code: 'custom',
        path: ['comment'],
        message:
          value.decision === 'reject'
            ? 'Explain why the result is rejected'
            : 'Correction feedback is required',
      });
  });

export const skipPipelineStepSchema = z.strictObject({
  runId: idSchema,
  stepId: idSchema,
  reason: z.string().trim().min(1).max(pipelineLimits.skipReason),
});

const definitionTargetShape = {
  directory: directorySchema,
  scope: definitionScopeSchema,
  kind: definitionKindSchema,
  name: stepNameSchema,
};

export const savePipelineDefinitionSchema = z.strictObject({
  ...definitionTargetShape,
  document: z.string().min(1).max(pipelineCommandLimits.document),
});

export const deletePipelineDefinitionSchema = z.strictObject(
  definitionTargetShape,
);

export const readPipelineEvidenceSchema = z.strictObject({
  runId: idSchema,
  stepId: idSchema,
  path: z.string().min(1).max(pipelineCommandLimits.evidencePath),
});

export const pipelineEvidenceSchema = z.strictObject({
  status: z.enum(['text', 'binary', 'too-large', 'missing']),
  text: z.string().max(pipelineCommandLimits.evidencePreviewBytes).nullable(),
  bytes: z.number().int().nonnegative(),
});

export type ListPipelineDefinitionsInput = z.infer<
  typeof listPipelineDefinitionsSchema
>;
export type ValidatePipelineDefinitionsInput = z.infer<
  typeof validatePipelineDefinitionsSchema
>;
export type StartPipelineTaskInput = z.infer<typeof startPipelineTaskSchema>;
export type RunPipelineStepsInput = z.infer<typeof runPipelineStepsSchema>;
export type ListPipelineRunsInput = z.input<typeof listPipelineRunsSchema>;
export type PipelineRunReference = z.infer<typeof pipelineRunReferenceSchema>;
export type DecidePipelineGateInput = z.input<typeof decidePipelineGateSchema>;
export type SkipPipelineStepInput = z.infer<typeof skipPipelineStepSchema>;
export type SavePipelineDefinitionInput = z.infer<
  typeof savePipelineDefinitionSchema
>;
export type DeletePipelineDefinitionInput = z.infer<
  typeof deletePipelineDefinitionSchema
>;
export type ReadPipelineEvidenceInput = z.infer<
  typeof readPipelineEvidenceSchema
>;
export type PipelineEvidence = z.infer<typeof pipelineEvidenceSchema>;
