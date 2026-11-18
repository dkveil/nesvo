import { z } from 'zod';
import { providerSchema } from './sessions';

export const conversationImportLimit = 128;

export const conversationIdentitySchema = z.strictObject({
  provider: providerSchema,
  providerSessionId: z.uuid(),
});

export const adoptConversationSchema = conversationIdentitySchema.extend({
  requestId: z.uuid(),
});

export const conversationImportCatalogSchema = z.strictObject({
  conversations: z
    .array(
      conversationIdentitySchema.extend({
        directory: z.string().min(1).max(4096),
        title: z.string().min(1).max(100),
        lastActivityAt: z.iso.datetime(),
        messageCount: z.number().int().positive(),
        adopted: z.boolean(),
        preview: z.string().min(1).max(480),
      }),
    )
    .max(conversationImportLimit),
  skippedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type ConversationImportCatalog = z.infer<
  typeof conversationImportCatalogSchema
>;
export type AdoptConversationInput = z.infer<typeof adoptConversationSchema>;
