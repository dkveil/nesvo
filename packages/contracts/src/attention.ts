import { z } from 'zod';
import { hostIdSchema } from './computers';

export const ATTENTION_MENU_SESSIONS = 5;

export const attentionSessionSchema = z.strictObject({
  hostId: hostIdSchema,
  sessionId: z.uuid(),
  title: z.string().max(200),
});

export const desktopAttentionSchema = z.strictObject({
  count: z.number().int().min(0).max(100_000),
  sessions: z.array(attentionSessionSchema).max(ATTENTION_MENU_SESSIONS),
});

export type AttentionSession = z.infer<typeof attentionSessionSchema>;
export type DesktopAttention = z.infer<typeof desktopAttentionSchema>;

export const keepRunningInBackgroundSchema = z.boolean();
