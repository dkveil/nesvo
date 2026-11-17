import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { mcpLimits, type McpScope } from '@nesvo/contracts';
import { readConfigFile } from './config-file';
import {
  definitionFingerprint,
  describeServer,
  type McpEndpoint,
  type McpEntry,
} from './server-summary';

const MAX_GLOBAL_CONFIG_BYTES = 32 * 1024 * 1024;
const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;
const MAX_PARENT_DIRECTORIES = 64;

const serverTableSchema = z.record(z.string(), z.unknown());
const globalConfigSchema = z.looseObject({
  mcpServers: serverTableSchema.optional(),
  projects: z
    .record(
      z.string(),
      z.looseObject({ mcpServers: serverTableSchema.optional() }),
    )
    .optional(),
});
const projectConfigSchema = z.looseObject({
  mcpServers: serverTableSchema.optional(),
});
const stdioSchema = z.looseObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(32_000)).max(500).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const remoteSchema = z.looseObject({
  type: z.enum(['http', 'sse']),
  url: z.string().min(1).max(8192),
  headers: z.record(z.string(), z.string()).optional(),
});

export const claudeConfigDirectory = (): string =>
  process.env.CLAUDE_CONFIG_DIR?.trim() || homedir();

const projectKey = (path: string): string => {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const claudeEndpoint = (
  value: unknown,
): { endpoint: McpEndpoint; definition: Record<string, unknown> } | null => {
  const stdio = stdioSchema.safeParse(value);
  if (stdio.success)
    return {
      endpoint: { transport: 'stdio', command: stdio.data.command, url: null },
      definition: stdio.data,
    };
  const remote = remoteSchema.safeParse(value);
  if (remote.success)
    return {
      endpoint: {
        transport: remote.data.type,
        command: null,
        url: remote.data.url,
      },
      definition: remote.data,
    };
  return null;
};

const claudeEntry = (
  key: Buffer,
  name: string,
  scope: McpScope,
  value: unknown,
): McpEntry => {
  const parsed = claudeEndpoint(value);
  if (parsed)
    return {
      server: describeServer({
        name,
        scope,
        endpoint: parsed.endpoint,
        problem: null,
        fingerprint: definitionFingerprint(key, parsed.definition),
      }),
      definition: parsed.definition,
    };
  const type =
    value !== null && typeof value === 'object' && 'type' in value
      ? value.type
      : undefined;
  return {
    server: describeServer({
      name,
      scope,
      endpoint: null,
      fingerprint: null,
      problem:
        typeof type === 'string' && !['stdio', 'http', 'sse'].includes(type)
          ? 'Nesvo can pass only stdio, HTTP and SSE servers to Claude Code.'
          : 'This server definition could not be read.',
    }),
    definition: null,
  };
};

const entriesOf = (
  key: Buffer,
  table: Record<string, unknown> | undefined,
  scope: McpScope,
): McpEntry[] =>
  Object.entries(table ?? {}).map(([name, value]) =>
    claudeEntry(key, name, scope, value),
  );

const readGlobal = async (
  key: Buffer,
  directory: string,
  issues: string[],
  signal?: AbortSignal,
): Promise<McpEntry[]> => {
  const file = await readConfigFile(
    join(claudeConfigDirectory(), '.claude.json'),
    MAX_GLOBAL_CONFIG_BYTES,
    signal,
  );
  if (file.status === 'missing') return [];
  if (file.status !== 'read') {
    issues.push('The Claude Code user configuration could not be read.');
    return [];
  }
  let parsed: z.infer<typeof globalConfigSchema>;
  try {
    const result = globalConfigSchema.safeParse(JSON.parse(file.text));
    if (!result.success) throw new Error();
    parsed = result.data;
  } catch {
    issues.push('The Claude Code user configuration is not valid.');
    return [];
  }
  const wanted = projectKey(directory);
  const local = Object.entries(parsed.projects ?? {}).find(
    ([path]) => projectKey(path) === wanted,
  )?.[1];
  return [
    ...entriesOf(key, parsed.mcpServers, 'user'),
    ...entriesOf(key, local?.mcpServers, 'local'),
  ];
};

const readProject = async (
  key: Buffer,
  directory: string,
  issues: string[],
  signal?: AbortSignal,
): Promise<McpEntry[]> => {
  const entries = new Map<string, McpEntry>();
  let current = directory;
  for (let depth = 0; depth < MAX_PARENT_DIRECTORIES; depth++) {
    const file = await readConfigFile(
      join(current, '.mcp.json'),
      MAX_PROJECT_CONFIG_BYTES,
      signal,
    );
    if (file.status === 'read') {
      try {
        const result = projectConfigSchema.safeParse(JSON.parse(file.text));
        if (!result.success) throw new Error();
        for (const entry of entriesOf(key, result.data.mcpServers, 'project'))
          if (!entries.has(entry.server.key))
            entries.set(entry.server.key, entry);
      } catch {
        issues.push('A project .mcp.json file is not valid.');
      }
    } else if (file.status !== 'missing')
      issues.push('A project .mcp.json file could not be read.');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...entries.values()];
};

export const discoverClaudeServers = async (
  key: Buffer,
  directory: string,
  signal?: AbortSignal,
): Promise<{ entries: McpEntry[]; issues: string[] }> => {
  const issues: string[] = [];
  const [global, project] = await Promise.all([
    readGlobal(key, directory, issues, signal),
    readProject(key, directory, issues, signal),
  ]);
  return {
    entries: [...global, ...project].slice(0, mcpLimits.listed),
    issues: [...new Set(issues)].slice(0, mcpLimits.issues),
  };
};
