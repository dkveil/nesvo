import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { mcpLimits, type McpScope, type McpServer } from '@nesvo/contracts';
import { readConfigFile } from './config-file';
import { describeServer } from './server-summary';

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

const entriesOf = (
  table: Record<string, unknown> | undefined,
  scope: McpScope,
): McpServer[] =>
  Object.entries(table ?? {}).map(([name, value]) => {
    const remote = remoteSchema.safeParse(value);
    const transport = remote.success
      ? remote.data.type
      : stdioSchema.safeParse(value).success
        ? 'stdio'
        : null;
    return describeServer(
      name,
      scope,
      transport,
      transport ? null : 'Server transport could not be identified.',
    );
  });

const readGlobal = async (
  directory: string,
  issues: string[],
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<McpServer[]> => {
  const file = await readConfigFile(
    join(profileDirectory ?? claudeConfigDirectory(), '.claude.json'),
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
    ...entriesOf(parsed.mcpServers, 'user'),
    ...entriesOf(local?.mcpServers, 'local'),
  ];
};

const readProject = async (
  directory: string,
  issues: string[],
  signal?: AbortSignal,
): Promise<McpServer[]> => {
  const entries = new Map<string, McpServer>();
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
        for (const entry of entriesOf(result.data.mcpServers, 'project'))
          if (!entries.has(entry.key)) entries.set(entry.key, entry);
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
  directory: string,
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<{ servers: McpServer[]; issues: string[] }> => {
  const issues: string[] = [];
  const [global, project] = await Promise.all([
    readGlobal(directory, issues, signal, profileDirectory),
    readProject(directory, issues, signal),
  ]);
  return {
    servers: [...global, ...project].slice(0, mcpLimits.listed),
    issues: [...new Set(issues)].slice(0, mcpLimits.issues),
  };
};
