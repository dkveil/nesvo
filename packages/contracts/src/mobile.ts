import { z } from 'zod';
import {
  computerSchema,
  desktopSessionSchema,
  hostIdSchema,
} from './computers';
import {
  decideDelegationSchema,
  respondApprovalSchema,
  sendMessageSchema,
  stopRunSchema,
} from './sessions';

export const mobileLimits = {
  protocolVersion: 1,
  requestBytes: 256 * 1024,
  responseBytes: 8 * 1024 * 1024,
  sessions: 512,
  devices: 16,
  clients: 8,
  pairingMs: 120000,
} as const;

const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const baseUrlSchema = z
  .url()
  .max(2048)
  .regex(
    /^https?:\/\/[^/@?#\s]+\/?$/i,
    'Use a gateway origin without credentials, a path, a query or a fragment.',
  )
  .refine(
    value =>
      !/^http:\/\//i.test(value) ||
      /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i.test(value),
    'Plain HTTP mobile access is limited to loopback.',
  );

export const mobileComputerSchema = computerSchema.pick({
  id: true,
  name: true,
  kind: true,
  status: true,
  lastSyncedAt: true,
});
export type MobileComputer = z.infer<typeof mobileComputerSchema>;

export const mobileDeviceSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type MobileDevice = z.infer<typeof mobileDeviceSchema>;

export const mobileGatewayStatusSchema = z.strictObject({
  enabled: z.boolean(),
  serverId: z.uuid(),
  url: baseUrlSchema.nullable(),
  clients: z.number().int().min(0).max(mobileLimits.clients),
  devices: z.array(mobileDeviceSchema).max(mobileLimits.devices),
});
export type MobileGatewayStatus = z.infer<typeof mobileGatewayStatusSchema>;

export const mobilePairingSchema = z.strictObject({
  serverId: z.uuid(),
  link: z.string().min(1).max(4096),
  expiresAt: z.iso.datetime(),
});
export type MobilePairing = z.infer<typeof mobilePairingSchema>;

export const mobilePairingLinkSchema = z.strictObject({
  url: baseUrlSchema,
  serverId: z.uuid(),
  secret: secretSchema,
});
export type MobilePairingLink = z.infer<typeof mobilePairingLinkSchema>;

export const mobilePairRequestSchema = z.strictObject({
  serverId: z.uuid(),
  secret: secretSchema,
  name: z.string().trim().min(1).max(80),
});
export type MobilePairRequest = z.infer<typeof mobilePairRequestSchema>;
export const mobilePairResponseSchema = z.strictObject({
  serverId: z.uuid(),
  deviceId: z.uuid(),
  token: secretSchema,
});
export type MobilePairResponse = z.infer<typeof mobilePairResponseSchema>;
export const mobileCredentialsSchema = mobilePairResponseSchema.extend({
  url: baseUrlSchema,
});
export type MobileCredentials = z.infer<typeof mobileCredentialsSchema>;
export const mobileHealthSchema = z.strictObject({
  serverId: z.uuid(),
  protocolVersion: z.literal(1),
});

export const mobileSnapshotSchema = z.strictObject({
  serverId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  computers: z.array(mobileComputerSchema).max(9),
  sessions: z.array(desktopSessionSchema).max(mobileLimits.sessions),
});
export type MobileSnapshot = z.infer<typeof mobileSnapshotSchema>;

export const mobileCommandSchema = z.discriminatedUnion('method', [
  z.strictObject({
    id: z.uuid(),
    hostId: hostIdSchema,
    method: z.literal('send-message'),
    input: sendMessageSchema.omit({ skillId: true, skillHash: true }),
  }),
  z.strictObject({
    id: z.uuid(),
    hostId: hostIdSchema,
    method: z.literal('stop-run'),
    input: stopRunSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    hostId: hostIdSchema,
    method: z.literal('respond-approval'),
    input: respondApprovalSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    hostId: hostIdSchema,
    method: z.literal('decide-delegation'),
    input: decideDelegationSchema,
  }),
]);
export type MobileCommand = z.infer<typeof mobileCommandSchema>;
export const mobileErrorCodeSchema = z.enum([
  'unauthorized',
  'revoked',
  'invalid-request',
  'too-large',
  'busy',
  'unavailable',
  'protocol-mismatch',
  'server-mismatch',
]);
export const mobileErrorSchema = z.strictObject({
  type: z.literal('error'),
  id: z.uuid().nullable(),
  code: mobileErrorCodeSchema,
  message: z.string().max(500),
});
export type MobileError = z.infer<typeof mobileErrorSchema>;
export const mobileCommandResponseSchema = z.union([
  z.strictObject({
    type: z.literal('session'),
    id: z.uuid(),
    session: desktopSessionSchema,
  }),
  mobileErrorSchema,
]);
export type MobileCommandResponse = z.infer<typeof mobileCommandResponseSchema>;

export const mobileAuthenticateSchema = z.strictObject({
  type: z.literal('authenticate'),
  protocolVersion: z.literal(1),
  serverId: z.uuid(),
  token: secretSchema,
});
export const mobileServerMessageSchema = z.union([
  mobileSnapshotSchema.extend({ type: z.literal('snapshot') }),
  z.strictObject({
    type: z.literal('session-changed'),
    sequence: z.number().int().positive(),
    session: desktopSessionSchema,
  }),
  z.strictObject({
    type: z.literal('computers-changed'),
    sequence: z.number().int().positive(),
    computers: z.array(mobileComputerSchema).max(9),
  }),
  z.strictObject({
    type: z.literal('host-disconnected'),
    sequence: z.number().int().positive(),
    hostId: hostIdSchema,
  }),
  z.strictObject({
    type: z.literal('host-snapshot'),
    sequence: z.number().int().positive(),
    hostId: hostIdSchema,
    sessions: z.array(desktopSessionSchema).max(mobileLimits.sessions),
  }),
  mobileErrorSchema,
]);
export type MobileServerMessage = z.infer<typeof mobileServerMessageSchema>;
