import { z } from 'zod';
import {
  claudeStatusSchema,
  createSessionSchema,
  desktopEventSchema,
  sendMessageSchema,
  sessionSchema,
  stopRunSchema,
  type ClaudeStatus,
  type CreateSessionInput,
  type DesktopEvent,
  type SendMessageInput,
  type Session,
  type StopRunInput,
} from './sessions';

export * from './sessions';

export const hostRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ id: z.uuid(), method: z.literal('health') }),
  z.strictObject({ id: z.uuid(), method: z.literal('shutdown') }),
  z.strictObject({ id: z.uuid(), method: z.literal('claude-status') }),
  z.strictObject({ id: z.uuid(), method: z.literal('list-sessions') }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('create-session'),
    input: createSessionSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('send-message'),
    input: sendMessageSchema,
  }),
  z.strictObject({
    id: z.uuid(),
    method: z.literal('stop-run'),
    input: stopRunSchema,
  }),
]);

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
    type: z.literal('claude-status'),
    id: z.uuid(),
    status: claudeStatusSchema,
  }),
  z.strictObject({
    type: z.literal('sessions'),
    id: z.uuid(),
    sessions: z.array(sessionSchema),
  }),
  z.strictObject({
    type: z.literal('session'),
    id: z.uuid(),
    session: sessionSchema,
  }),
  z.strictObject({
    type: z.literal('error'),
    id: z.uuid().nullable(),
    code: z.enum([
      'invalid-request',
      'unavailable',
      'busy',
      'not-found',
      'invalid-directory',
    ]),
    message: z.string().optional(),
  }),
]);

export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostHealth = z.infer<typeof hostHealthSchema>;
export type HostResponse = z.infer<typeof hostResponseSchema>;
export const hostMessageSchema = z.union([
  hostResponseSchema,
  desktopEventSchema,
]);
export type HostMessage = z.infer<typeof hostMessageSchema>;
export type DesktopApi = {
  health: () => Promise<HostHealth>;
  claudeStatus: () => Promise<ClaudeStatus>;
  listSessions: () => Promise<Session[]>;
  createSession: (input: CreateSessionInput) => Promise<Session>;
  sendMessage: (input: SendMessageInput) => Promise<Session>;
  stopRun: (input: StopRunInput) => Promise<Session>;
  subscribe: (listener: (event: DesktopEvent) => void) => () => void;
};
