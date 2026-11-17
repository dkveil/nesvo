import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { mcpLimits } from '@nesvo/contracts';
import { readConfigFile } from './config-file';
import { describeServer, type McpEndpoint, type McpEntry } from './server-summary';

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

export const codexEndpoint = (value: unknown): McpEndpoint | null => {
  const parsed = serverSchema.safeParse(value);
  if (!parsed.success) return null;
  const { command, url } = parsed.data;
  if (command && !url) return { transport: 'stdio', command, url: null };
  if (url && !command) return { transport: 'http', command: null, url };
  return null;
};

const codexEntry = (name: string, value: unknown): McpEntry => {
  const endpoint = codexEndpoint(value);
  const disabled = serverSchema.safeParse(value).data?.enabled === false;
  return {
    server: describeServer({
      name,
      scope: 'user',
      endpoint,
      problem: !endpoint
        ? 'This server definition could not be read.'
        : disabled
          ? 'This server is turned off in the Codex configuration.'
          : null,
    }),
    definition: null,
  };
};

export const discoverCodexServers = async (
  signal?: AbortSignal,
): Promise<{ entries: McpEntry[]; issues: string[] }> => {
  const file = await readConfigFile(
    join(codexHome(), 'config.toml'),
    MAX_CONFIG_BYTES,
    signal,
  );
  if (file.status === 'missing') return { entries: [], issues: [] };
  if (file.status !== 'read')
    return {
      entries: [],
      issues: ['The Codex configuration could not be read.'],
    };
  let table: Record<string, unknown> | undefined;
  try {
    const result = configSchema.safeParse(parse(file.text));
    if (!result.success) throw new Error();
    table = result.data.mcp_servers;
  } catch {
    return {
      entries: [],
      issues: ['The Codex configuration is not valid TOML.'],
    };
  }
  return {
    entries: Object.entries(table ?? {})
      .map(([name, value]) => codexEntry(name, value))
      .slice(0, mcpLimits.listed),
    issues: [],
  };
};
