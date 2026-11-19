import { z } from 'zod';
import { mcpFingerprintSchema } from './mcp-selection';
import { providerSchema } from './sessions';

const repositoryPath = z.string().min(1).max(4096);
const hostname =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const segment = /^[a-zA-Z0-9_.~-]{1,128}$/;

export const repositorySegment = (value: string) =>
  value !== '.' && value !== '..' && segment.test(value);

export const repositoryHost = (value: string) => {
  const [host, port, extra] = value.split(':');
  return (
    !!host &&
    hostname.test(host) &&
    extra === undefined &&
    (port === undefined ||
      (/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535))
  );
};

const repositoryAddress = (value: string, pattern: boolean) => {
  const [host, ...path] = value.split('/');
  return (
    repositoryHost(host!) &&
    path.length >= 1 &&
    path.length <= 12 &&
    path.every(part => (pattern && part === '*') || repositorySegment(part))
  );
};

export const repositoryRemoteSchema = z
  .string()
  .max(1024)
  .refine(value => repositoryAddress(value, false));
export const repositoryPatternSchema = z
  .string()
  .max(1024)
  .refine(value => repositoryAddress(value, true));

const checkoutIdentity = {
  root: repositoryPath,
  gitDirectory: repositoryPath,
  checkouts: z.array(repositoryPath).min(1).max(256),
};

export const repositoryIdentitySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('remote'),
    ...checkoutIdentity,
    remote: repositoryRemoteSchema,
  }),
  z.strictObject({ status: z.literal('local'), ...checkoutIdentity }),
  z.strictObject({ status: z.literal('ambiguous'), ...checkoutIdentity }),
  z.strictObject({ status: z.literal('unverified'), root: repositoryPath }),
]);

export type RepositoryIdentity = z.infer<typeof repositoryIdentitySchema>;

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
  actor: z.literal('operator'),
  action: z.enum(['add-pattern', 'revoke', 'approve', 'defer']),
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
