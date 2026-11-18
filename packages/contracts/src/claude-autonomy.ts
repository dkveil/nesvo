import { z } from 'zod';

export const allowScopeSchema = z.enum(['session', 'project']);
export const allowPatternSchema = z.strictObject({
  tool: z.string().min(1).max(200),
  pattern: z.string().min(1).max(4200),
});
export const allowRuleSchema = allowPatternSchema.extend({
  id: z.uuid(),
  sessionId: z.uuid(),
  scope: allowScopeSchema,
  directory: z.string().min(1).max(4096),
  createdAt: z.iso.datetime(),
});
export const claudeAutonomySchema = z.strictObject({
  fullAccessEnabled: z.boolean(),
  rules: z.array(allowRuleSchema).max(200),
});
export const claudeAutonomyInputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('read') }),
  z.strictObject({
    action: z.literal('set-full-access'),
    enabled: z.boolean(),
  }),
  z.strictObject({
    action: z.literal('confirm-full-access'),
    sessionId: z.uuid(),
    directory: z.string().min(1).max(4096),
  }),
  z.strictObject({ action: z.literal('remove-rule'), id: z.uuid() }),
]);

export type AllowScope = z.infer<typeof allowScopeSchema>;
export type AllowPattern = z.infer<typeof allowPatternSchema>;
export type AllowRule = z.infer<typeof allowRuleSchema>;
export type ClaudeAutonomy = z.infer<typeof claudeAutonomySchema>;
export type ClaudeAutonomyInput = z.infer<typeof claudeAutonomyInputSchema>;
