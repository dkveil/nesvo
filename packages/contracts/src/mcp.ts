import { z } from 'zod';
import {
  mcpFingerprintSchema,
  mcpLimits,
  mcpScopeSchema,
} from './mcp-selection';
import { providerSchema } from './sessions';

export const mcpTransportSchema = z.enum(['stdio', 'http', 'sse']);

export const mcpServerSchema = z.strictObject({
  key: z.string().min(1).max(400),
  name: z.string().min(1).max(300),
  scope: mcpScopeSchema,
  transport: mcpTransportSchema.nullable(),
  summary: z.string().max(mcpLimits.summary).nullable(),
  fingerprint: mcpFingerprintSchema.nullable(),
  problem: z.string().max(mcpLimits.problem).nullable(),
});

export const mcpServerListSchema = z.strictObject({
  provider: providerSchema,
  servers: z.array(mcpServerSchema).max(mcpLimits.listed),
  issues: z.array(z.string().max(mcpLimits.problem)).max(mcpLimits.issues),
});

export const listMcpServersSchema = z.union([
  z.strictObject({ sessionId: z.uuid() }),
  z.strictObject({
    provider: providerSchema,
    profileId: z.uuid().nullable().optional(),
    directory: z.string().trim().max(4096),
  }),
]);

export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpServerList = z.infer<typeof mcpServerListSchema>;
export type ListMcpServersInput = z.infer<typeof listMcpServersSchema>;
