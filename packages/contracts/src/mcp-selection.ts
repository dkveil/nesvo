import { z } from 'zod';

export const mcpLimits = {
  enabled: 50,
  listed: 200,
  issues: 20,
  summary: 200,
  problem: 300,
} as const;

export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export const mcpScopeSchema = z.enum(['user', 'project', 'local']);
export const mcpServerKeySchema = z
  .string()
  .regex(/^(?:user|project|local):[A-Za-z0-9_-]{1,100}$/);
export const mcpFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const mcpServerNameOf = (key: string): string =>
  key.slice(key.indexOf(':') + 1);

const mcpServerKeysSchema = z
  .array(mcpServerKeySchema)
  .max(mcpLimits.enabled)
  .refine(keys => new Set(keys).size === keys.length, {
    message: 'Each MCP server can be enabled once',
  })
  .refine(keys => new Set(keys.map(mcpServerNameOf)).size === keys.length, {
    message: 'Enable only one MCP server with the same name',
  });

export const mcpSelectionSchema = z.strictObject({
  servers: mcpServerKeysSchema,
  hooks: z.boolean(),
});

export const setSessionMcpSchema = z.strictObject({
  sessionId: z.uuid(),
  servers: mcpServerKeysSchema,
  hooks: z.boolean(),
});

export const sessionMcpSchema = z.strictObject({
  servers: z
    .array(
      z.strictObject({
        key: mcpServerKeySchema,
        fingerprint: mcpFingerprintSchema,
      }),
    )
    .max(mcpLimits.enabled),
  hooks: z.boolean(),
});

export const messageMcpSchema = z.strictObject({
  servers: z.array(mcpServerKeySchema).max(mcpLimits.enabled),
  hooks: z.boolean(),
});

export type McpScope = z.infer<typeof mcpScopeSchema>;
export type McpSelection = z.infer<typeof mcpSelectionSchema>;
export type SetSessionMcpInput = z.infer<typeof setSessionMcpSchema>;
export type SessionMcp = z.infer<typeof sessionMcpSchema>;
export type MessageMcp = z.infer<typeof messageMcpSchema>;
