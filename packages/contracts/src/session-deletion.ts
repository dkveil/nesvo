import { z } from 'zod';
import { hostIdSchema } from './computers';

export const SESSION_DELETE_GRACE_MS = 30_000;
export const SESSION_DELETE_BATCH_LIMIT = 500;

export const deleteSessionSchema = z.strictObject({
  sessionId: z.uuid(),
});

export const restoreSessionSchema = z.strictObject({
  sessionId: z.uuid(),
});

export const sessionDeletionSchema = z.strictObject({
  sessionId: z.uuid(),
  sessionIds: z.array(z.uuid()).min(1).max(SESSION_DELETE_BATCH_LIMIT),
  title: z.string().max(200),
  deletedAt: z.iso.datetime(),
  purgeAfter: z.iso.datetime(),
});

export const desktopSessionDeletionSchema = sessionDeletionSchema.extend({
  hostId: hostIdSchema,
});

export type DeleteSessionInput = z.infer<typeof deleteSessionSchema>;
export type RestoreSessionInput = z.infer<typeof restoreSessionSchema>;
export type SessionDeletion = z.infer<typeof sessionDeletionSchema>;
export type DesktopSessionDeletion = z.infer<
  typeof desktopSessionDeletionSchema
>;
