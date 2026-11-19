import { z } from 'zod';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const toolName = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9_.-]+$/);
const serverName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
const selection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tool'), tool: toolName }),
  z.strictObject({ kind: z.literal('server') }),
]);

export const readonlyMcpObservationSchema = z.strictObject({
  sessionId: z.uuid(),
  server: serverName,
  transport: z.literal('https'),
  endpoint: z.string().url().max(1024),
  tools: z
    .array(
      z.strictObject({
        name: toolName,
        digest: fingerprint,
        readOnlyHint: z.boolean().nullable(),
      }),
    )
    .min(1)
    .max(100),
  revision: fingerprint,
});

export const readonlyMcpGrantSchema = readonlyMcpObservationSchema.extend({
  id: z.uuid(),
  profileId: z.uuid().nullable(),
  selection,
  createdAt: z.iso.datetime(),
});

export const readonlyIntegrationInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read'), sessionId: z.uuid().optional() }),
  z.strictObject({
    action: z.literal('inspect-mcp'),
    sessionId: z.uuid(),
    server: serverName,
  }),
  z.strictObject({
    action: z.literal('approve-mcp'),
    actionId: z.uuid(),
    sessionId: z.uuid(),
    server: serverName,
    revision: fingerprint,
    selection,
  }),
  z.strictObject({
    action: z.literal('revoke'),
    actionId: z.uuid(),
    grantId: z.uuid(),
  }),
]);

export const readonlyIntegrationReplySchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('read'),
    grants: z.array(readonlyMcpGrantSchema).max(100),
    claudeHookReason: z.string().max(500),
    codexHookReason: z.string().max(500),
    claudeMcpReason: z.string().max(500),
    history: z
      .array(
        z.strictObject({
          id: z.uuid(),
          grantId: z.uuid(),
          sessionId: z.uuid(),
          hostId: z.uuid(),
          runId: z.uuid().nullable(),
          action: z.enum(['approve', 'revoke', 'invoke']),
          actor: z.enum(['operator', 'host']),
          tool: toolName.nullable(),
          revision: fingerprint,
          at: z.iso.datetime(),
        }),
      )
      .max(100),
  }),
  z.strictObject({
    action: z.literal('inspect-mcp'),
    observation: readonlyMcpObservationSchema,
  }),
  z.strictObject({
    action: z.literal('approve-mcp'),
    grant: readonlyMcpGrantSchema,
  }),
  z.strictObject({ action: z.literal('revoke') }),
]);

export type ReadonlyMcpObservation = z.infer<
  typeof readonlyMcpObservationSchema
>;
export type ReadonlyMcpGrant = z.infer<typeof readonlyMcpGrantSchema>;
export type ReadonlyIntegrationInput = z.infer<
  typeof readonlyIntegrationInputSchema
>;
export type ReadonlyIntegrationReply = z.infer<
  typeof readonlyIntegrationReplySchema
>;
