import { z } from 'zod';
import { externalInboxTokenSchema } from './external-inbox';
import { utf8ByteLength } from './workflow-share';

const label = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const externalSessionKindSchema = z.enum(['send', 'notify']);
export const externalSessionDestinationSchema = z.enum([
  'session',
  'inbox',
  'reject',
]);
const groupKey = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('id'), id: z.uuid() }),
  z.strictObject({ kind: z.literal('name'), name: label(120) }),
]);
export const externalSessionTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('id'), sessionId: z.uuid() }),
  z.strictObject({
    kind: z.literal('title'),
    title: label(100),
    group: groupKey,
  }),
]);
export const externalSessionTextSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine(value => utf8ByteLength(value) <= 8192);

export const externalSessionMessageSchema = z.strictObject({
  kind: externalSessionKindSchema,
  source: label(64),
  target: externalSessionTargetSchema,
  text: externalSessionTextSchema,
  idempotencyKey: label(128),
});
export const externalSessionRequestSchema = z.strictObject({
  token: externalInboxTokenSchema,
  message: externalSessionMessageSchema,
});

const state = z.enum([
  'routing',
  'queued',
  'notification',
  'inbox',
  'rejected',
  'dismissed',
  'held',
  'delivering',
  'delivered',
  'uncertain',
]);
const provenance = z.strictObject({
  kind: z.enum(['device', 'watcher']),
  id: z.uuid(),
  label: label(64),
});
export const sessionIngressReceiptSchema = z.strictObject({
  id: z.uuid(),
  computerId: z.uuid(),
  source: label(64),
  provenance,
  kind: externalSessionKindSchema,
  destination: externalSessionDestinationSchema,
  status: state,
  sessionId: z.uuid().nullable(),
  groupId: z.uuid().nullable(),
  inboxId: z.uuid().nullable(),
  at: z.iso.datetime(),
  reason: z.string().max(400).nullable(),
});
export const externalSessionReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), receipt: sessionIngressReceiptSchema }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum([
      'unauthorized',
      'invalid-request',
      'not-found',
      'conflict',
      'rate-limit',
      'pending-limit',
      'unavailable',
    ]),
    message: z.string().max(200),
  }),
]);
export const externalSessionRuleInputSchema = z.strictObject({
  deviceId: z.uuid(),
  source: label(64),
  kinds: z
    .array(externalSessionKindSchema)
    .min(1)
    .max(2)
    .refine(values => new Set(values).size === values.length),
  destination: externalSessionDestinationSchema,
  sessions: z.array(z.uuid()).max(32).default([]),
});
export const externalSessionRuleSchema = externalSessionRuleInputSchema.extend({
  id: z.uuid(),
  revision: digest,
  at: z.iso.datetime(),
});

export const externalSessionMessageEntrySchema = z.strictObject({
  receipt: sessionIngressReceiptSchema,
  text: externalSessionTextSchema,
  changes: z
    .array(
      z.strictObject({
        action: state,
        actor: z.enum(['device', 'watcher', 'host', 'operator']),
        at: z.iso.datetime(),
        messageId: z.uuid().nullable(),
      }),
    )
    .max(32),
});
export const externalSessionSettingsInputSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({ action: z.literal('read') }),
    z.strictObject({ action: z.literal('history'), sessionId: z.uuid() }),
    z.strictObject({
      action: z.literal('save-route'),
      actionId: z.uuid(),
      rule: externalSessionRuleInputSchema,
    }),
    z.strictObject({
      action: z.literal('revoke-route'),
      actionId: z.uuid(),
      routeId: z.uuid(),
    }),
    z.strictObject({
      action: z.literal('continue'),
      actionId: z.uuid(),
      receiptId: z.uuid(),
    }),
    z.strictObject({
      action: z.literal('dismiss'),
      actionId: z.uuid(),
      receiptId: z.uuid(),
    }),
  ],
);
export const externalSessionSettingsSchema = z.strictObject({
  routes: z.array(externalSessionRuleSchema).max(128),
  messages: z.array(externalSessionMessageEntrySchema).max(100),
  rulesHistory: z
    .array(
      z.strictObject({
        actionId: z.uuid(),
        action: z.enum(['save-route', 'revoke-route', 'continue', 'dismiss']),
        target: z.uuid(),
        at: z.iso.datetime(),
        revision: digest,
      }),
    )
    .max(100),
});

export type ExternalSessionMessage = z.infer<
  typeof externalSessionMessageSchema
>;
export type SessionIngressReceipt = z.infer<typeof sessionIngressReceiptSchema>;
export type ExternalSessionReply = z.infer<typeof externalSessionReplySchema>;
export type ExternalSessionRule = z.infer<typeof externalSessionRuleSchema>;
export type ExternalSessionSettings = z.infer<
  typeof externalSessionSettingsSchema
>;
export type ExternalSessionSettingsInput = z.infer<
  typeof externalSessionSettingsInputSchema
>;
export type ExternalSessionMessageEntry = z.infer<
  typeof externalSessionMessageEntrySchema
>;
