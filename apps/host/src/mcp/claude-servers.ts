import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MCP_SERVER_NAME_PATTERN, type McpScope } from '@nesvo/contracts';
import { describeServer } from './server-summary';
import {
  configTable,
  directoryKey,
  section,
  type ConfigTable,
} from './scoped-config';

const stdioSchema = z.strictObject({
  type: z.literal('stdio').optional(),
  command: z.string().min(1).max(4096),
  args: z.array(z.string().max(32_000)).max(500).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
const remoteSchema = z.strictObject({
  type: z.enum(['http', 'sse']),
  url: z.string().min(1).max(8192),
  headers: z.record(z.string(), z.string()).optional(),
});
const serverSchema = z.union([stdioSchema, remoteSchema]);

export const claudeConfigDirectory = (): string =>
  process.env.CLAUDE_CONFIG_DIR?.trim() || homedir();

export function claudeServer(name: string, value: unknown, scope: McpScope) {
  const parsed = serverSchema.safeParse(value);
  const supported = parsed.success && MCP_SERVER_NAME_PATTERN.test(name);
  return describeServer(
    name,
    scope,
    parsed.data?.type ?? (parsed.success ? 'stdio' : null),
    supported ? null : 'Server definition is unsupported.',
  );
}

export async function readClaudeConfiguration(
  folders: string[],
  issues: string[],
  projectIssues: string[],
  signal?: AbortSignal,
  profileDirectory?: string,
) {
  const home = profileDirectory ?? claudeConfigDirectory();
  const [global, userSettings] = await Promise.all([
    configTable(join(home, '.claude.json'), issues, signal, 32 * 1024 * 1024),
    configTable(
      join(
        profileDirectory ??
          process.env.CLAUDE_CONFIG_DIR?.trim() ??
          join(homedir(), '.claude'),
        'settings.json',
      ),
      issues,
      signal,
    ),
  ]);
  const userServers = section(global, 'mcpServers', issues);
  const userHooks = section(userSettings, 'hooks', issues);
  const local = section(global, 'projects', issues);
  const matchingFolders = new Set(folders.map(directoryKey));
  const localSettings = Object.fromEntries(
    Object.entries(local).filter(([path]) =>
      matchingFolders.has(directoryKey(path)),
    ),
  );
  if (issues.length)
    projectIssues.push('Claude Code local MCP settings could not be verified.');

  const layers = await Promise.all(
    [...folders].reverse().map(async folder => {
      const [mcp, settings, localFile] = await Promise.all([
        configTable(join(folder, '.mcp.json'), projectIssues, signal),
        configTable(
          join(folder, '.claude', 'settings.json'),
          projectIssues,
          signal,
        ),
        configTable(
          join(folder, '.claude', 'settings.local.json'),
          projectIssues,
          signal,
        ),
      ]);
      const localConfig = Object.entries(localSettings).find(
        ([path]) => directoryKey(path) === directoryKey(folder),
      )?.[1];
      const localServers =
        localConfig && typeof localConfig === 'object'
          ? section(localConfig as ConfigTable, 'mcpServers', projectIssues)
          : {};
      return {
        folder,
        servers: section(mcp, 'mcpServers', projectIssues),
        localServers,
        hooks: section(settings, 'hooks', projectIssues),
        localHooks: section(localFile, 'hooks', projectIssues),
        hooksDisabled:
          settings.disableAllHooks === true ||
          localFile.disableAllHooks === true,
      };
    }),
  );
  return { userServers, userHooks, layers };
}
