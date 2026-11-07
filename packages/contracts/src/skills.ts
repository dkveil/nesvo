import { z } from 'zod';

export const skillLimits = {
  entries: 500,
  issues: 30,
  name: 256,
  description: 4000,
  path: 4096,
  detail: 800,
} as const;

export const discoverSkillsSchema = z.strictObject({ sessionId: z.uuid() });
export const skillOriginsSchema = z
  .array(z.enum(['Claude Code', 'Codex', 'Shared']))
  .max(3);
export const skillHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const skillEntrySchema = z.strictObject({
  id: z.string().min(1).max(8192),
  name: z.string().min(1).max(skillLimits.name),
  description: z.string().max(skillLimits.description),
  path: z.string().min(1).max(skillLimits.path).nullable(),
  source: z.enum(['project', 'user', 'system', 'managed', 'plugin', 'unknown']),
  kind: z.enum(['skill', 'command']),
  enabled: z.boolean().nullable(),
  userInvocable: z.boolean().nullable(),
  modelInvocable: z.boolean().nullable(),
  detail: z.string().max(skillLimits.detail).nullable(),
  origins: skillOriginsSchema.optional(),
  invocation: z.enum(['native', 'instructions', 'blocked']).optional(),
  invocationReason: z.string().max(skillLimits.detail).nullable().optional(),
  contentHash: skillHashSchema.optional(),
});

export const skillReferenceSchema = skillEntrySchema
  .pick({ id: true, name: true, path: true, source: true })
  .extend({
    path: z.string().min(1).max(skillLimits.path),
    origins: skillOriginsSchema.optional(),
    delivery: z.enum(['native', 'instructions']).optional(),
    contentHash: skillHashSchema.optional(),
  });

export const skillDiscoverySchema = z.strictObject({
  provider: z.enum(['Claude Code', 'Codex']),
  method: z.enum(['native', 'filesystem', 'library']),
  status: z.enum(['ready', 'partial', 'unsupported', 'unavailable']),
  skills: z.array(skillEntrySchema).max(skillLimits.entries),
  issues: z
    .array(
      z.strictObject({
        path: z.string().max(skillLimits.path).nullable(),
        message: z.string().max(skillLimits.detail),
      }),
    )
    .max(skillLimits.issues),
  truncated: z.boolean(),
  invocationSupported: z.boolean(),
  checkedAt: z.iso.datetime(),
});

export const skillCatalogSchema = skillDiscoverySchema.extend({
  sessionId: z.uuid(),
});

export type DiscoverSkillsInput = z.infer<typeof discoverSkillsSchema>;
export type SkillEntry = z.infer<typeof skillEntrySchema>;
export type SkillReference = z.infer<typeof skillReferenceSchema>;
export type SkillDiscovery = z.infer<typeof skillDiscoverySchema>;
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;
