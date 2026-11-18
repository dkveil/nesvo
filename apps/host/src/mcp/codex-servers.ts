import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { mcpLimits } from '@nesvo/contracts';
import { readConfigFile } from './config-file';
import {
  canonicalJson,
  definitionFingerprint,
  describeServer,
  type McpEndpoint,
  type McpEntry,
} from './server-summary';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const REPORTED_DEFAULTS: Readonly<Record<string, unknown>> = {
  environment_id: 'local',
  args: [],
};

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

const codexEndpoint = (value: unknown): McpEndpoint | null => {
  const parsed = serverSchema.safeParse(value);
  if (!parsed.success) return null;
  const { command, url } = parsed.data;
  if (command && !url) return { transport: 'stdio', command, url: null };
  if (url && !command) return { transport: 'http', command: null, url };
  return null;
};

export const sameCodexServer = (
  expected: Record<string, unknown>,
  effective: unknown,
): boolean => {
  if (effective === null || typeof effective !== 'object') return false;
  const actual = effective as Record<string, unknown>;
  if (actual.enabled === false) return false;
  const fields = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  fields.delete('enabled');
  return [...fields].every(field =>
    Object.hasOwn(expected, field)
      ? canonicalJson(expected[field]) === canonicalJson(actual[field])
      : actual[field] == null ||
        canonicalJson(actual[field]) ===
          canonicalJson(REPORTED_DEFAULTS[field]),
  );
};

const codexEntry = (key: Buffer, name: string, value: unknown): McpEntry => {
  const endpoint = codexEndpoint(value);
  const disabled = serverSchema.safeParse(value).data?.enabled === false;
  const definition =
    endpoint && value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  return {
    server: describeServer({
      name,
      scope: 'user',
      endpoint,
      fingerprint: definition ? definitionFingerprint(key, definition) : null,
      problem: !definition
        ? 'This server definition could not be read.'
        : disabled
          ? 'This server is turned off in the Codex configuration.'
          : null,
    }),
    definition,
  };
};

export const discoverCodexServers = async (
  key: Buffer,
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<{ entries: McpEntry[]; issues: string[] }> => {
  const file = await readConfigFile(
    join(profileDirectory ?? codexHome(), 'config.toml'),
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
      .map(([name, value]) => codexEntry(key, name, value))
      .slice(0, mcpLimits.listed),
    issues: [],
  };
};
