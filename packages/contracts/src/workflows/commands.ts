import { z } from 'zod';
import { humanDecisionAnswerSchema } from './human-decisions';
import { reasoningEffortSchema } from '../reasoning-effort';
import {
  claudeModelSchema,
  isProviderSessionMode,
  providerSchema,
  sessionModeSchema,
} from '../sessions';
import {
  definitionHashSchema,
  definitionIssueSchema,
  definitionCatalogSchema,
  definitionKindSchema,
  definitionScopeSchema,
  workflowDefinitionLimits,
  stepNameSchema,
  stepPhaseSchema,
} from './definitions';
import { workflowLimits } from './runs';

export const workflowCommandLimits = {
  title: workflowDefinitionLimits.specTitle,
  model: 200,
  comment: 8000,
  document: 65_536,
  evidencePath: 1024,
  evidencePreviewBytes: 262_144,
} as const;

const idSchema = z.uuid();
const directorySchema = z.string().trim().max(workflowDefinitionLimits.path);
const specPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(workflowDefinitionLimits.path)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const modelSchema = z.string().trim().min(1).max(workflowCommandLimits.model);

export const listWorkflowDefinitionsSchema = z.strictObject({
  directory: directorySchema,
});

export const validateWorkflowDefinitionsSchema = listWorkflowDefinitionsSchema;

export const startWorkflowTaskSchema = z
  .strictObject({
    specPath: specPathSchema,
    workflowName: stepNameSchema,
    forceFullLane: z.literal(true).optional(),
    title: z.string().trim().min(1).max(workflowCommandLimits.title).optional(),
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
      !isProviderSessionMode(value.provider, value.mode) ||
      (value.provider === 'Claude Code' &&
        (value.mode !== 'read-only' ||
          !claudeModelSchema.safeParse(value.model).success))
    )
      context.addIssue({
        code: 'custom',
        path: ['model'],
        message: `Unsupported ${value.provider} model or mode`,
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
            ? 'Claude Code workflow tasks do not accept an effort yet'
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

export const runWorkflowStepsSchema = z.strictObject({
  specPath: specPathSchema,
  directory: directorySchema,
  phase: stepPhaseSchema.optional(),
});

export const listWorkflowRunsSchema = z.strictObject({
  cursor: z.string().min(1).max(workflowLimits.cursor).nullable().default(null),
  limit: z.number().int().min(1).max(workflowLimits.runPage).default(20),
});

export const workflowRunReferenceSchema = z.strictObject({ runId: idSchema });
export const getWorkflowRunSchema = workflowRunReferenceSchema;
export const resumeWorkflowRunSchema = workflowRunReferenceSchema;
export const stopWorkflowRunSchema = workflowRunReferenceSchema;
export const removeWorkflowWorktreeSchema = workflowRunReferenceSchema;

export const decideWorkflowGateSchema = z
  .strictObject({
    runId: idSchema,
    stepId: idSchema,
    reviewId: idSchema.nullable(),
    version: z.number().int().positive().nullable(),
    decisionId: idSchema,
    decision: z.enum(['accept', 'reject', 'fix']),
    answer: humanDecisionAnswerSchema.optional(),
    comment: z.string().trim().max(workflowCommandLimits.comment).default(''),
  })
  .superRefine((value, context) => {
    if (value.decision !== 'accept' && value.answer)
      context.addIssue({
        code: 'custom',
        path: ['answer'],
        message: 'Only confirmations can carry a decision answer.',
      });
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

export const skipWorkflowStepSchema = z.strictObject({
  runId: idSchema,
  stepId: idSchema,
  reason: z.string().trim().min(1).max(workflowLimits.skipReason),
});

export const resolveWorkflowStepSchema = z
  .strictObject({
    runId: idSchema,
    stepId: idSchema,
    decisionId: idSchema,
    resolution: z.enum(['mark-done', 'run-again']),
    comment: z.string().trim().max(workflowCommandLimits.comment).default(''),
  })
  .superRefine((value, context) => {
    if (value.resolution === 'mark-done' && !value.comment)
      context.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'Describe what you verified before marking the step done',
      });
  });

const definitionTargetShape = {
  directory: directorySchema,
  scope: definitionScopeSchema,
  kind: definitionKindSchema,
  name: stepNameSchema,
};

export const saveWorkflowDefinitionSchema = z.strictObject({
  ...definitionTargetShape,
  document: z.string().min(1).max(workflowCommandLimits.document),
  expectedHash: definitionHashSchema.nullable(),
});

export const deleteWorkflowDefinitionSchema = z.strictObject({
  ...definitionTargetShape,
  expectedHash: definitionHashSchema,
});

export const workflowDefinitionConflictSchema = z.strictObject({
  type: z.literal('workflow-definition-conflict'),
  scope: definitionScopeSchema,
  kind: definitionKindSchema,
  name: stepNameSchema,
  path: z.string().min(1).max(workflowDefinitionLimits.path),
  currentHash: definitionHashSchema.nullable(),
  document: z.string().max(workflowCommandLimits.document).nullable(),
});

export const workflowDefinitionRefusedSchema = z.strictObject({
  type: z.literal('workflow-definition-refused'),
  issues: z
    .array(definitionIssueSchema)
    .min(1)
    .max(workflowDefinitionLimits.issues),
});

export const definitionWriteResultSchema = z.union([
  definitionCatalogSchema,
  workflowDefinitionConflictSchema,
  workflowDefinitionRefusedSchema,
]);

export const readWorkflowEvidenceSchema = z.strictObject({
  runId: idSchema,
  stepId: idSchema,
  path: z.string().min(1).max(workflowCommandLimits.evidencePath),
});

export const workflowEvidenceSchema = z.strictObject({
  status: z.enum(['text', 'binary', 'too-large', 'missing']),
  text: z.string().max(workflowCommandLimits.evidencePreviewBytes).nullable(),
  bytes: z.number().int().nonnegative(),
});

export type ListWorkflowDefinitionsInput = z.infer<
  typeof listWorkflowDefinitionsSchema
>;
export type ValidateWorkflowDefinitionsInput = z.infer<
  typeof validateWorkflowDefinitionsSchema
>;
export type StartWorkflowTaskInput = z.infer<typeof startWorkflowTaskSchema>;
export type RunWorkflowStepsInput = z.infer<typeof runWorkflowStepsSchema>;
export type ListWorkflowRunsInput = z.input<typeof listWorkflowRunsSchema>;
export type WorkflowRunReference = z.infer<typeof workflowRunReferenceSchema>;
export type DecideWorkflowGateInput = z.input<typeof decideWorkflowGateSchema>;
export type SkipWorkflowStepInput = z.infer<typeof skipWorkflowStepSchema>;
export type ResolveWorkflowStepInput = z.input<
  typeof resolveWorkflowStepSchema
>;
export type SaveWorkflowDefinitionInput = z.infer<
  typeof saveWorkflowDefinitionSchema
>;
export type DeleteWorkflowDefinitionInput = z.infer<
  typeof deleteWorkflowDefinitionSchema
>;
export type WorkflowDefinitionConflict = z.infer<
  typeof workflowDefinitionConflictSchema
>;
export type WorkflowDefinitionRefused = z.infer<
  typeof workflowDefinitionRefusedSchema
>;
export type DefinitionWriteResult = z.infer<typeof definitionWriteResultSchema>;
export type ReadWorkflowEvidenceInput = z.infer<
  typeof readWorkflowEvidenceSchema
>;
export type WorkflowEvidence = z.infer<typeof workflowEvidenceSchema>;
