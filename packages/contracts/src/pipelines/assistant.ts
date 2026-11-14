import { z } from 'zod';
import { reasoningEffortSchema } from '../reasoning-effort';
import { providerSchema } from '../sessions';
import {
  definitionHashSchema,
  definitionIssueSchema,
  definitionKindSchema,
  definitionScopeSchema,
  pipelineDefinitionLimits,
  stepNameSchema,
} from './definitions';

export const pipelineAssistantLimits = {
  document: 65_536,
  text: 8000,
  model: 200,
  selection: 32,
  summary: 400,
  message: 4000,
  changes: 8,
  issues: 8,
  changeIssues: 50,
} as const;

export const pipelineAssistantDocumentSchema = z.strictObject({
  kind: definitionKindSchema,
  scope: definitionScopeSchema,
  name: stepNameSchema,
  contentHash: definitionHashSchema,
  text: z.string().max(pipelineAssistantLimits.document),
});

export const pipelineAssistantContextSchema = z.strictObject({
  directory: z.string().trim().max(pipelineDefinitionLimits.path),
  pipelineName: stepNameSchema.nullable(),
  document: pipelineAssistantDocumentSchema.nullable(),
  selection: z
    .array(stepNameSchema)
    .max(pipelineAssistantLimits.selection)
    .default([]),
});

export const pipelineAssistantSendSchema = z.strictObject({
  sessionId: z.uuid().nullable(),
  provider: providerSchema,
  model: z.string().trim().min(1).max(pipelineAssistantLimits.model),
  effort: reasoningEffortSchema.nullable().default(null),
  text: z.string().trim().min(1).max(pipelineAssistantLimits.text),
  context: pipelineAssistantContextSchema,
});

export const pipelineAssistantChangeSchema = z.strictObject({
  kind: definitionKindSchema,
  scope: definitionScopeSchema,
  name: stepNameSchema,
  basedOnHash: definitionHashSchema.nullable(),
  document: z.string().max(pipelineAssistantLimits.document),
  summary: z.string().max(pipelineAssistantLimits.summary),
});

export const pipelineAssistantProposalSchema = z.strictObject({
  message: z.string().max(pipelineAssistantLimits.message),
  changes: z
    .array(pipelineAssistantChangeSchema)
    .max(pipelineAssistantLimits.changes),
});

export const pipelineAssistantProposalJsonSchema = () =>
  z.toJSONSchema(pipelineAssistantProposalSchema, { io: 'input' });

export const pipelineAssistantProposalEventSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  status: z.enum(['ok', 'invalid']),
  proposal: pipelineAssistantProposalSchema.nullable(),
  issues: z
    .array(
      z.strictObject({
        index: z
          .number()
          .int()
          .min(0)
          .max(pipelineAssistantLimits.changes - 1),
        issues: z
          .array(definitionIssueSchema)
          .max(pipelineAssistantLimits.changeIssues),
      }),
    )
    .max(pipelineAssistantLimits.issues),
});

export const pipelineAssistantTurnSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
});

export type PipelineAssistantDocument = z.infer<
  typeof pipelineAssistantDocumentSchema
>;
export type PipelineAssistantContext = z.infer<
  typeof pipelineAssistantContextSchema
>;
export type PipelineAssistantSendInput = z.input<
  typeof pipelineAssistantSendSchema
>;
export type PipelineAssistantChange = z.infer<
  typeof pipelineAssistantChangeSchema
>;
export type PipelineAssistantProposal = z.infer<
  typeof pipelineAssistantProposalSchema
>;
export type PipelineAssistantProposalEvent = z.infer<
  typeof pipelineAssistantProposalEventSchema
>;
export type PipelineAssistantTurn = z.infer<typeof pipelineAssistantTurnSchema>;
