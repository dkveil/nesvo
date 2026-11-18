import { z } from 'zod';

export const externalInboxLimits = {
  title: 160,
  body: 4000,
  source: 64,
  action: 32,
  actions: 3,
  key: 128,
  perMinute: 10,
  pending: 5,
  hostPending: 200,
  devices: 20,
  waitSeconds: 3600,
} as const;

const label = (limit: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(limit)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u);

export const externalInboxActionsSchema = z
  .array(label(externalInboxLimits.action))
  .min(1)
  .max(externalInboxLimits.actions)
  .refine(
    actions =>
      new Set(actions.map(action => action.toLowerCase())).size ===
      actions.length,
    'Use distinct action labels.',
  );

export const externalInboxPostSchema = z.strictObject({
  title: label(externalInboxLimits.title),
  body: z.string().max(externalInboxLimits.body).default(''),
  actions: externalInboxActionsSchema.default(['approve', 'reject']),
  source: label(externalInboxLimits.source).optional(),
  sessionId: z.uuid().optional(),
  idempotencyKey: label(externalInboxLimits.key),
});
export type ExternalInboxPost = z.output<typeof externalInboxPostSchema>;

export const externalInboxCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('post'),
    item: externalInboxPostSchema,
  }),
  z.strictObject({ operation: z.literal('status'), itemId: z.uuid() }),
  z.strictObject({ operation: z.literal('cancel'), itemId: z.uuid() }),
]);

export const externalInboxTokenSchema = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43}$/,
  );
export const externalInboxRequestSchema = z.strictObject({
  token: externalInboxTokenSchema,
  command: externalInboxCommandSchema,
});
export type ExternalInboxRequest = z.output<typeof externalInboxRequestSchema>;

export const externalInboxResultSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['pending', 'answered', 'cancelled']),
  action: z.string().max(externalInboxLimits.action).nullable(),
  actionIndex: z
    .number()
    .int()
    .min(0)
    .max(externalInboxLimits.actions - 1)
    .nullable(),
  comment: z.string().max(2000).nullable(),
});
export type ExternalInboxResult = z.infer<typeof externalInboxResultSchema>;

export const externalInboxReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), item: externalInboxResultSchema }),
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
export type ExternalInboxReply = z.infer<typeof externalInboxReplySchema>;
export type ExternalInboxErrorCode = Extract<
  ExternalInboxReply,
  { ok: false }
>['code'];

export const externalInboxDeviceNameSchema = z.strictObject({
  name: label(externalInboxLimits.source),
});
export const externalInboxDeviceIdSchema = z.strictObject({
  deviceId: z.uuid(),
});
export const externalInboxDeviceSchema = z.strictObject({
  id: z.uuid(),
  name: label(externalInboxLimits.source),
  createdAt: z.iso.datetime(),
});
export const externalInboxDevicesSchema = z
  .array(externalInboxDeviceSchema)
  .max(externalInboxLimits.devices);
export const externalInboxEnrollmentSchema = z.strictObject({
  device: externalInboxDeviceSchema,
  token: externalInboxTokenSchema,
});
export type ExternalInboxDevice = z.infer<typeof externalInboxDeviceSchema>;

export const externalInboxWaitSchema = z
  .strictObject({
    wait: z.boolean().default(false),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(externalInboxLimits.waitSeconds)
      .optional(),
  })
  .refine(
    input => input.wait || input.timeout === undefined,
    'Timeout requires wait.',
  );

const computer = z.union([z.literal('local'), z.uuid()]).optional();

export const externalInboxMcpPostSchema = externalInboxPostSchema
  .extend({
    idempotencyKey: externalInboxPostSchema.shape.idempotencyKey.optional(),
    ...externalInboxWaitSchema.shape,
    computer,
  })
  .refine(
    input => input.wait || input.timeout === undefined,
    'Timeout requires wait.',
  );

export const externalInboxMcpLookupSchema = z.strictObject({
  id: z.uuid(),
  computer,
});
