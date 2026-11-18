import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { mcpLimits, type McpServer } from '@nesvo/contracts';
import { readConfigFile } from './config-file';
import { describeServer } from './server-summary';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const configSchema = z.looseObject({
  mcp_servers: z.record(z.string(), z.unknown()).optional(),
});
const serverSchema = z.looseObject({
  command: z.string().min(1).max(4096).optional(),
  url: z.string().min(1).max(8192).optional(),
  enabled: z.boolean().optional(),
});

export const codexHome = (): string =>
  process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');

const codexServer = (name: string, value: unknown): McpServer => {
  const { command, url, enabled } = serverSchema.safeParse(value).data ?? {};
  const transport = command && !url ? 'stdio' : url && !command ? 'http' : null;
  const problem =
    enabled === false
      ? 'Disabled in the provider configuration.'
      : !transport
        ? 'Server transport could not be identified.'
        : null;
  return describeServer(name, 'user', transport, problem);
};

export const discoverCodexServers = async (
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<{ servers: McpServer[]; issues: string[] }> => {
  const file = await readConfigFile(
    join(profileDirectory ?? codexHome(), 'config.toml'),
    MAX_CONFIG_BYTES,
    signal,
  );
  if (file.status === 'missing') return { servers: [], issues: [] };
  if (file.status !== 'read')
    return {
      servers: [],
      issues: ['The Codex configuration could not be read.'],
    };
  let table: Record<string, unknown> | undefined;
  try {
    const result = configSchema.safeParse(parse(file.text));
    if (!result.success) throw new Error();
    table = result.data.mcp_servers;
  } catch {
    return {
      servers: [],
      issues: ['The Codex configuration is not valid TOML.'],
    };
  }
  return {
    servers: Object.entries(table ?? {})
      .map(([name, value]) => codexServer(name, value))
      .slice(0, mcpLimits.listed),
    issues: [],
  };
};
