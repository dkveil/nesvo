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

const mcpRepositoryLaunchSchema = z.strictObject({
  kind: z.string().max(1024).optional(),
  fields: z
    .array(
      z.strictObject({
        label: z.enum([
          'Command',
          'Argument',
          'Working directory',
          'Environment variable',
          'URL',
          'Matcher',
        ]),
        value: z.string().max(1024 * 1024),
      }),
    )
    .max(16_384),
});

const mcpRepositoryDefinitionSchema = z.strictObject({
  id: z.string().min(1).max(400),
  name: z.string().min(1).max(300),
  detail: z.string().max(mcpLimits.summary),
  launches: z.array(mcpRepositoryLaunchSchema).max(8192).optional(),
  change: z.enum(['added', 'changed', 'removed']).nullable(),
});

const mcpRepositorySchema = z.strictObject({
  name: z.string().max(4096),
  status: z.enum(['empty', 'needs-trust', 'trusted', 'unavailable']),
  fingerprint: mcpFingerprintSchema,
  definitions: z.array(mcpRepositoryDefinitionSchema).max(2 * mcpLimits.listed),
  changed: z.boolean(),
});

export const trustRepositoryMcpSchema = z.strictObject({
  sessionId: z.uuid(),
  fingerprint: mcpFingerprintSchema,
});

export type McpRepositoryDefinition = z.infer<
  typeof mcpRepositoryDefinitionSchema
>;
export type McpRepositoryLaunch = z.infer<typeof mcpRepositoryLaunchSchema>;
export type TrustRepositoryMcpInput = z.infer<typeof trustRepositoryMcpSchema>;

export const mcpServerListSchema = z.strictObject({
  provider: providerSchema,
  servers: z.array(mcpServerSchema).max(mcpLimits.listed),
  configuration: z.literal('native').optional(),
  repository: mcpRepositorySchema.optional(),
  readOnlyMcp: z.enum(['approval', 'isolated']).optional(),
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
