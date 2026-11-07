import { z } from 'zod';

export const claudeModelSchema = z.enum(['default', 'opus', 'sonnet', 'haiku']);
export const sessionStateSchema = z.enum([
  'ready',
  'running',
  'stopping',
  'completed',
  'stopped',
  'failed',
  'interrupted',
]);
export const createSessionSchema = z.strictObject({
  title: z.string().trim().min(1).max(100),
  model: claudeModelSchema,
  role: z.enum(['orchestrator', 'standalone']),
  directory: z.string().trim().max(4096),
});
export const sendMessageSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  text: z.string().trim().min(1).max(32000),
});
export const stopRunSchema = z.strictObject({
  sessionId: z.uuid(),
  runId: z.uuid(),
});
export const sessionMessageSchema = z.strictObject({
  id: z.uuid(),
  runId: z.uuid(),
  author: z.enum(['operator', 'agent']),
  body: z.string().max(2_000_000),
  state: sessionStateSchema,
  createdAt: z.iso.datetime(),
});
export const sessionSchema = z.strictObject({
  id: z.uuid(),
  provider: z.literal('Claude Code'),
  providerSessionId: z.uuid(),
  providerInitialized: z.boolean(),
  title: z.string(),
  model: claudeModelSchema,
  actualModel: z.string().nullable(),
  role: z.enum(['orchestrator', 'standalone']),
  directory: z.string(),
  status: sessionStateSchema,
  error: z.string().nullable(),
  activity: z.string().nullable(),
  runId: z.uuid().nullable(),
  revision: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(sessionMessageSchema),
});
export const claudeStatusSchema = z.strictObject({
  status: z.enum([
    'ready',
    'missing',
    'unauthenticated',
    'unsupported',
    'error',
  ]),
  version: z.string().nullable(),
  detail: z.string().nullable(),
  models: z.array(z.strictObject({ id: claudeModelSchema, label: z.string() })),
});
export const desktopEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('session-changed'),
    session: sessionSchema,
  }),
  z.strictObject({ type: z.literal('host-disconnected') }),
]);

export type Session = z.infer<typeof sessionSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type StopRunInput = z.infer<typeof stopRunSchema>;
export type ClaudeStatus = z.infer<typeof claudeStatusSchema>;
export type DesktopEvent = z.infer<typeof desktopEventSchema>;
