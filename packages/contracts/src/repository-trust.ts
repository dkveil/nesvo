import { z } from 'zod';
import { mcpFingerprintSchema } from './mcp-selection';
import { providerSchema } from './sessions';

import {
  repositoryPath,
  repositoryPatternSchema,
  repositoryRemoteSchema,
} from './repository-identity';
export * from './repository-identity';

export const repositoryTrustRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: z.uuid(),
    kind: z.literal('pattern'),
    pattern: repositoryPatternSchema,
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  }),
  z.strictObject({
    id: z.uuid(),
    kind: z.literal('repository'),
    gitDirectory: repositoryPath,
    remote: repositoryRemoteSchema.nullable(),
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  }),
]);

export const repositoryTrustDecisionSchema = z.strictObject({
  id: z.uuid(),
  hostId: z.uuid(),
  actor: z.enum(['operator', 'host']),
  action: z.enum(['add-pattern', 'revoke', 'approve', 'defer', 'migrate']),
  target: z.string().min(1).max(4096),
  ruleId: z.uuid().nullable(),
  sessionId: z.uuid().nullable(),
  provider: providerSchema.nullable(),
  fingerprint: mcpFingerprintSchema.nullable(),
  at: z.iso.datetime(),
});

export const repositoryTrustSettingsInputSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({ action: z.literal('read') }),
    z.strictObject({
      action: z.literal('add-pattern'),
      actionId: z.uuid(),
      pattern: repositoryPatternSchema,
    }),
    z.strictObject({
      action: z.literal('revoke'),
      actionId: z.uuid(),
      ruleId: z.uuid(),
    }),
  ],
);

export const repositoryTrustReviewInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('approve'),
    actionId: z.uuid(),
    pattern: repositoryPatternSchema.optional(),
  }),
  z.strictObject({ action: z.literal('defer'), actionId: z.uuid() }),
]);

export const repositoryTrustSettingsSchema = z.strictObject({
  rules: z.array(repositoryTrustRuleSchema).max(256),
  history: z.array(repositoryTrustDecisionSchema).max(100),
});

export type RepositoryTrustRule = z.infer<typeof repositoryTrustRuleSchema>;
export type RepositoryTrustDecision = z.infer<
  typeof repositoryTrustDecisionSchema
>;
export type RepositoryTrustSettingsInput = z.infer<
  typeof repositoryTrustSettingsInputSchema
>;
export type RepositoryTrustReviewInput = z.infer<
  typeof repositoryTrustReviewInputSchema
>;
export type RepositoryTrustSettings = z.infer<
  typeof repositoryTrustSettingsSchema
>;
