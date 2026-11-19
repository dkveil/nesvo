import { z } from 'zod';
import {
  autonomySettingsInputSchema,
  autonomyStatisticsSchema,
  autonomyTargetSchema,
  overrideGatePolicySchema,
} from './autonomy';
import { checkCandidateSchema } from './checks';
import {
  ruleEntryBodySchema,
  ruleEntryDescriptionSchema,
  ruleEntryIdSchema,
  ruleEntryLimits,
} from '../rule-entries';
import {
  definitionHashSchema,
  definitionScopeSchema,
  stepNameSchema,
} from './definitions';

export const gateRuleLimits = {
  proposalsPerRun: 2,
  pending: 50,
  promptCharacters: 8000,
  justification: 800,
} as const;

const content = {
  description: ruleEntryDescriptionSchema,
  kind: z.enum(['check', 'instruction']),
  steps: z.array(stepNameSchema).min(1).max(4),
  body: ruleEntryBodySchema,
};

const targetSchema = z.strictObject({
  id: ruleEntryIdSchema('gate-rule'),
  hash: definitionHashSchema,
  scope: definitionScopeSchema,
});

export const proposedGateRuleSchema = z.strictObject({
  ...content,
  update: targetSchema.nullable(),
  quote: z.string().trim().min(1).max(ruleEntryLimits.quote),
  justification: z.string().trim().min(1).max(gateRuleLimits.justification),
});
export type ProposedGateRule = z.infer<typeof proposedGateRuleSchema>;

export const gateRuleOutputSchema = z.strictObject({
  proposals: z
    .array(proposedGateRuleSchema)
    .max(gateRuleLimits.proposalsPerRun),
});
export const gateRuleOutputJsonSchema = () =>
  z.toJSONSchema(gateRuleOutputSchema, { io: 'input' });

export const gateRuleEditSchema = z.strictObject({
  ...content,
  scope: definitionScopeSchema,
});
export type GateRuleEdit = z.infer<typeof gateRuleEditSchema>;

const decision = {
  proposalId: z.uuid(),
  revision: z.number().int().positive(),
  decisionId: z.uuid(),
};
export const decideGateRuleSchema = z.union([
  z.strictObject({ ...decision, action: z.enum(['accept', 'dismiss']) }),
  z.strictObject({
    ...decision,
    action: z.literal('edit'),
    edit: gateRuleEditSchema,
  }),
]);
export type DecideGateRuleInput = z.infer<typeof decideGateRuleSchema>;

export const gateRuleProposalSchema = z.strictObject({
  origin: z.enum(['precedent', 'mapping', 'route']).optional(),
  mapping: z
    .strictObject({
      command: z.string().min(1).max(600),
      source: checkCandidateSchema.shape.source,
      expectedHash: definitionHashSchema.nullable(),
    })
    .optional(),
  id: z.uuid(),
  runId: z.uuid(),
  sessionId: z.uuid(),
  taskSessionId: z.uuid().nullable(),
  workflow: stepNameSchema,
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  status: z.enum(['pending', 'accepted', 'dismissed', 'stale']),
  proposal: proposedGateRuleSchema,
  scope: definitionScopeSchema,
  decisionKind: z.enum(['accept', 'fix', 'reject']),
  current: ruleEntryBodySchema.nullable(),
  changeId: z.uuid().nullable(),
  ruleId: z
    .union([ruleEntryIdSchema('gate-rule'), ruleEntryIdSchema('decision')])
    .nullable(),
  error: z.string().max(800).nullable(),
});
export type GateRuleProposal = z.infer<typeof gateRuleProposalSchema>;

export const gateRuleGenerationSchema = z.strictObject({
  runId: z.uuid(),
  sessionId: z.uuid().nullable(),
  status: z.enum([
    'running',
    'done',
    'none',
    'blocked',
    'failed',
    'invalid',
    'interrupted',
  ]),
  reason: z.string().max(800).nullable(),
  retries: z.number().int().min(0).max(2),
});
export type GateRuleGeneration = z.infer<typeof gateRuleGenerationSchema>;

export const gateRuleOverviewSchema = z.strictObject({
  decisionMemory: z.boolean().optional(),
  autonomy: autonomyStatisticsSchema.optional(),
  enabled: z.boolean(),
  proposals: z.array(gateRuleProposalSchema).max(gateRuleLimits.pending),
  generation: gateRuleGenerationSchema.nullable(),
});
export type GateRuleOverview = z.infer<typeof gateRuleOverviewSchema>;

export const gateRulesInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read'), runId: z.uuid().optional() }),
  z.strictObject({
    action: z.literal('autonomy-read'),
    target: autonomyTargetSchema,
  }),
  z.strictObject({
    action: z.literal('autonomy-set'),
    input: autonomySettingsInputSchema,
  }),
  z.strictObject({
    action: z.literal('autonomy-override'),
    input: overrideGatePolicySchema,
  }),
  z.strictObject({ action: z.literal('settings'), enabled: z.boolean() }),
  z.strictObject({
    action: z.literal('decision-memory'),
    enabled: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('decide'),
    decision: decideGateRuleSchema,
  }),
  z.strictObject({
    action: z.literal('retry'),
    runId: z.uuid(),
    requestId: z.uuid(),
  }),
]);
export type GateRulesInput = z.infer<typeof gateRulesInputSchema>;
