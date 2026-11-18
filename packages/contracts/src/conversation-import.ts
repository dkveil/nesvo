import { z } from 'zod';
import { providerSchema } from './sessions';

export const conversationImportLimit = 128;

export const conversationIdentitySchema = z.strictObject({
  provider: providerSchema,
  providerSessionId: z.uuid(),
});

export const adoptConversationSchema = conversationIdentitySchema.extend({
  requestId: z.uuid(),
  profileId: z.uuid().nullable().optional(),
});

export const listConversationsSchema = z
  .strictObject({
    include: conversationIdentitySchema.optional(),
    provider: providerSchema.optional(),
    profileId: z.uuid().nullable().optional(),
  })
  .refine(input => !input.profileId || input.provider !== undefined, {
    message: 'Choose a provider for the account.',
    path: ['provider'],
  })
  .refine(
    input =>
      !input.include ||
      !input.provider ||
      input.include.provider === input.provider,
    {
      message:
        'The included conversation must belong to the selected provider.',
      path: ['include'],
    },
  );

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
export type ConversationIdentity = z.infer<typeof conversationIdentitySchema>;
export type ListConversationsInput = z.infer<typeof listConversationsSchema>;
export type AdoptConversationInput = z.infer<typeof adoptConversationSchema>;
