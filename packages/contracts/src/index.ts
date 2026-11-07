import { z } from 'zod';

export const hostRequestSchema = z.strictObject({
  id: z.uuid(),
  method: z.enum(['health', 'shutdown']),
});

export const hostHealthSchema = z.strictObject({
  status: z.literal('ready'),
  instanceId: z.uuid(),
  protocolVersion: z.literal(1),
});

export const hostResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('health'),
    id: z.uuid(),
    health: hostHealthSchema,
  }),
  z.strictObject({ type: z.literal('shutdown'), id: z.uuid() }),
  z.strictObject({
    type: z.literal('error'),
    id: z.uuid().nullable(),
    code: z.enum(['invalid-request', 'unavailable']),
  }),
]);

export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostHealth = z.infer<typeof hostHealthSchema>;
export type HostResponse = z.infer<typeof hostResponseSchema>;
export type DesktopApi = { health: () => Promise<HostHealth> };
