import { z } from 'zod';
import { decisionRouteSchema } from './decision-route';
import { inboxRoutingReceiptSchema } from './inbox-rules';
import { providerSchema } from './sessions';

const sessionSubject = z.enum([
  'approval',
  'delegation',
  'parent',
  'plan',
  'question',
  'turn-question',
  'report',
  'coordinator-wait',
]);
export const configurationInboxSubjectSchema = z.union([
  z.strictObject({
    kind: z.literal('workflow-gate'),
    id: z.uuid(),
    runId: z.uuid(),
  }),
  z.strictObject({
    kind: z.enum(['rule', 'review', 'automation', 'gate-rule-proposal']),
    id: z.uuid(),
  }),
  z.strictObject({
    kind: sessionSubject,
    id: z.string().min(1).max(200),
    sessionId: z.uuid(),
  }),
]);
export const configurationInboxLookupSchema = z.strictObject({
  subject: configurationInboxSubjectSchema.nullable(),
  provider: providerSchema,
  model: z.string().min(1).max(200),
});
export const configurationInboxSendSchema =
  configurationInboxLookupSchema.extend({
    messageId: z.uuid(),
    text: z.string().trim().min(1).max(8000),
    newChat: z.boolean().default(false),
  });
export const configurationInboxContextSchema = z.strictObject({
  sessionId: z.uuid().nullable(),
  explanation: z.string().max(800),
  route: decisionRouteSchema.nullable(),
  rule: z
    .strictObject({
      name: z.string().max(80),
      scope: z.enum(['global', 'project']),
      current: z.enum(['unchanged', 'changed', 'missing', 'unknown']),
    })
    .nullable(),
  routing: inboxRoutingReceiptSchema.nullable(),
});
export const configurationInboxLookupResultSchema = z.strictObject({
  context: configurationInboxContextSchema,
  sessionId: z.uuid().nullable(),
});
export const configurationInboxSendResultSchema = z.strictObject({
  sessionId: z.uuid(),
});
export const configurationInboxOutputSchema = z.strictObject({
  reply: z.string().max(4000),
  rule: z
    .strictObject({
      scope: z.enum(['global', 'project']),
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
      document: z.string().min(1).max(16_384),
    })
    .nullable(),
});
export type ConfigurationInboxSubject = z.infer<
  typeof configurationInboxSubjectSchema
>;
export type ConfigurationInboxLookup = z.infer<
  typeof configurationInboxLookupSchema
>;
export type ConfigurationInboxSend = z.infer<
  typeof configurationInboxSendSchema
>;
export type ConfigurationInboxContext = z.infer<
  typeof configurationInboxContextSchema
>;
