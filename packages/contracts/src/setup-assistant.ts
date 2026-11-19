import { z } from 'zod';
import { reasoningEffortSchema } from './reasoning-effort';
import { providerSchema } from './sessions';
import {
  setupProfilePathSchema,
  setupProfileRecipeSchema,
} from './setup-profile';

const context = z.strictObject({
  instanceId: z.uuid(),
  provider: providerSchema,
  model: z.string().trim().min(1).max(200),
  effort: reasoningEffortSchema.optional(),
  directory: setupProfilePathSchema.optional(),
});

export const setupAssistantInputSchema = z.discriminatedUnion('action', [
  context.extend({ action: z.literal('read') }),
  context.extend({
    action: z.literal('send'),
    messageId: z.uuid(),
    text: z.string().trim().min(1).max(8000),
  }),
]);

export const setupAssistantOutputSchema = z.strictObject({
  reply: z.string().min(1).max(8000),
  recipe: setupProfileRecipeSchema.nullable(),
});

export type SetupAssistantInput = z.output<typeof setupAssistantInputSchema>;
