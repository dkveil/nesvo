import { z } from 'zod';
import { promptSkillSchema } from '../skills';
import { reasoningEffortSchema } from '../reasoning-effort';
import { providerSchema } from '../sessions';
import {
  definitionHashSchema,
  definitionIssueSchema,
  definitionKindSchema,
  definitionScopeSchema,
  workflowDefinitionLimits,
  stepNameSchema,
} from './definitions';

export const workflowAssistantLimits = {
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

export const workflowAssistantDocumentSchema = z.strictObject({
  kind: definitionKindSchema,
  scope: definitionScopeSchema,
  name: stepNameSchema,
  contentHash: definitionHashSchema,
  text: z.string().max(workflowAssistantLimits.document),
});

export const workflowAssistantViewSchema = z.enum([
  'workflows-list',
  'automations-list',
  'editor',
]);

export const workflowAssistantContextSchema = z.strictObject({
  view: workflowAssistantViewSchema.optional(),
  directory: z.string().trim().max(workflowDefinitionLimits.path),
  workflowName: stepNameSchema.nullable(),
  document: workflowAssistantDocumentSchema.nullable(),
  selection: z
    .array(stepNameSchema)
    .max(workflowAssistantLimits.selection)
    .default([]),
});

export const workflowAssistantSendSchema = z.strictObject({
  sessionId: z.uuid().nullable(),
  provider: providerSchema,
  model: z.string().trim().min(1).max(workflowAssistantLimits.model),
  effort: reasoningEffortSchema.nullable().default(null),
  text: z.string().trim().min(1).max(workflowAssistantLimits.text),
  promptSkill: promptSkillSchema.optional(),
  context: workflowAssistantContextSchema,
});

export const workflowAssistantChangeSchema = z.strictObject({
  kind: definitionKindSchema,
  scope: definitionScopeSchema,
  name: stepNameSchema,
  basedOnHash: definitionHashSchema.nullable(),
  document: z.string().max(workflowAssistantLimits.document),
  summary: z.string().max(workflowAssistantLimits.summary),
});

export const workflowAssistantProposalSchema = z.strictObject({
  message: z.string().max(workflowAssistantLimits.message),
  changes: z
    .array(workflowAssistantChangeSchema)
    .max(workflowAssistantLimits.changes),
});

export const workflowAssistantProposalJsonSchema = () =>
  z.toJSONSchema(workflowAssistantProposalSchema, { io: 'input' });

export const workflowAssistantProposalEventSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  status: z.enum(['ok', 'invalid']),
  proposal: workflowAssistantProposalSchema.nullable(),
  issues: z
    .array(
      z.strictObject({
        index: z
          .number()
          .int()
          .min(0)
          .max(workflowAssistantLimits.changes - 1),
        issues: z
          .array(definitionIssueSchema)
          .max(workflowAssistantLimits.changeIssues),
      }),
    )
    .max(workflowAssistantLimits.issues),
});

export const workflowAssistantTurnSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
});

export type WorkflowAssistantDocument = z.infer<
  typeof workflowAssistantDocumentSchema
>;
export type WorkflowAssistantView = z.infer<typeof workflowAssistantViewSchema>;
export type WorkflowAssistantContext = z.infer<
  typeof workflowAssistantContextSchema
>;
export type WorkflowAssistantSendInput = z.input<
  typeof workflowAssistantSendSchema
>;
export type WorkflowAssistantChange = z.infer<
  typeof workflowAssistantChangeSchema
>;
export type WorkflowAssistantProposal = z.infer<
  typeof workflowAssistantProposalSchema
>;
export type WorkflowAssistantProposalEvent = z.infer<
  typeof workflowAssistantProposalEventSchema
>;
export type WorkflowAssistantTurn = z.infer<typeof workflowAssistantTurnSchema>;
