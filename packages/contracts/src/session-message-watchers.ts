import { z } from 'zod';
import { directCommandSchema } from './direct-command';
import {
  externalSessionKindSchema,
  externalSessionTextSchema,
} from './external-session-messages';

const name = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const path = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\u0000-\u001f\u007f]+$/);

export const sessionMessageWatcherDefinitionSchema = z
  .strictObject({
    version: z.literal(1),
    name,
    source: name,
    directory: path,
    command: directCommandSchema,
    destination: z.enum(['session', 'inbox']),
    defaultSessionId: z.uuid(),
    allowedSessionIds: z.array(z.uuid()).min(1).max(32),
    kinds: z.array(externalSessionKindSchema).min(1).max(2),
  })
  .refine(definition =>
    definition.allowedSessionIds.includes(definition.defaultSessionId),
  );

export const sessionMessageWatcherLineSchema = z.strictObject({
  eventId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  kind: externalSessionKindSchema,
  text: externalSessionTextSchema,
  sessionId: z.uuid().optional(),
});

const watcher = z.strictObject({
  id: z.uuid(),
  name,
  source: name,
  defaultSessionId: z.uuid(),
  revision,
  state: z.enum(['idle', 'running', 'held']),
  invalidLines: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  detail: z.string().max(1024).nullable(),
  exitCode: z.number().int().nullable(),
});

const actionId = z.uuid();
export const sessionMessageWatcherInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({
    action: z.literal('inspect'),
    definition: sessionMessageWatcherDefinitionSchema,
  }),
  z.strictObject({
    action: z.literal('approve'),
    actionId,
    definition: sessionMessageWatcherDefinitionSchema,
    revision,
  }),
  z.strictObject({ action: z.literal('start'), actionId, watcherId: z.uuid() }),
  z.strictObject({ action: z.literal('stop'), actionId, watcherId: z.uuid() }),
  z.strictObject({
    action: z.literal('revoke'),
    actionId,
    watcherId: z.uuid(),
  }),
  z.strictObject({
    action: z.literal('renew'),
    watcherId: z.uuid(),
    leaseId: z.uuid(),
  }),
]);
export const sessionMessageWatcherReplySchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('read'),
    watchers: z.array(watcher).max(20),
    history: z
      .array(
        z.strictObject({
          id: z.uuid(),
          watcherId: z.uuid(),
          action: z.enum(['approve', 'start', 'stop', 'revoke', 'held']),
          revision,
          at: z.iso.datetime(),
          detail: z.string().max(1024).nullable(),
        }),
      )
      .max(100),
  }),
  z.strictObject({
    action: z.literal('inspect'),
    revision,
    cwd: path,
    executable: path,
    argv: z.array(z.string().max(4096)).max(64),
  }),
  z.strictObject({
    action: z.literal('start'),
    watcherId: z.uuid(),
    leaseId: z.uuid().nullable(),
    expiresAt: z.iso.datetime().nullable(),
  }),
  z.strictObject({
    action: z.literal('renew'),
    expiresAt: z.iso.datetime().nullable(),
  }),
  z.strictObject({ action: z.enum(['approve', 'stop', 'revoke']) }),
]);

export type SessionMessageWatcherDefinition = z.infer<
  typeof sessionMessageWatcherDefinitionSchema
>;
export type SessionMessageWatcherInput = z.infer<
  typeof sessionMessageWatcherInputSchema
>;
export type SessionMessageWatcherReply = z.infer<
  typeof sessionMessageWatcherReplySchema
>;
