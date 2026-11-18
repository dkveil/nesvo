import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { MCP_SERVER_NAME_PATTERN, type McpScope } from '@nesvo/contracts';
import { readClaudeProjectFiles, settingsRest } from './claude-project-files';
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
  const globalPath = join(home, '.claude.json');
  const [global, userSettings] = await Promise.all([
    configTable(globalPath, issues, signal, 32 * 1024 * 1024),
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

  const repositoryRoot = folders.at(-1);
  const layers = await Promise.all(
    [...folders].reverse().map(async folder => {
      const mcpPath = join(folder, '.mcp.json');
      const settingsPath = join(folder, '.claude', 'settings.json');
      const localPath = join(folder, '.claude', 'settings.local.json');
      const [mcp, settings, localFile] = await Promise.all([
        configTable(mcpPath, projectIssues, signal, undefined, repositoryRoot),
        configTable(
          settingsPath,
          projectIssues,
          signal,
          undefined,
          repositoryRoot,
        ),
        configTable(
          localPath,
          projectIssues,
          signal,
          undefined,
          repositoryRoot,
        ),
      ]);
      const [localFolder, localConfig] =
        Object.entries(localSettings).find(
          ([path]) => directoryKey(path) === directoryKey(folder),
        ) ?? [];
      const localServers =
        localConfig && typeof localConfig === 'object'
          ? section(localConfig as ConfigTable, 'mcpServers', projectIssues)
          : {};
      const servers = section(mcp, 'mcpServers', projectIssues);
      const hooks = section(settings, 'hooks', projectIssues);
      const localHooks = section(localFile, 'hooks', projectIssues);
      const projectFiles = await readClaudeProjectFiles(
        folder,
        repositoryRoot!,
        { project: settings, local: localFile },
        projectIssues,
        signal,
      );
      const projectSettings = settingsRest(settings);
      const localProjectSettings = settingsRest(localFile);
      return {
        servers,
        localServers,
        hooks,
        localHooks,
        hooksDisabled:
          settings.disableAllHooks === true ||
          localFile.disableAllHooks === true,
        localFolder,
        extras: projectFiles.definitions,
        sources: [
          { path: mcpPath, sections: { mcpServers: servers } },
          {
            path: settingsPath,
            sections: {
              hooks,
              ...(settings.disableAllHooks === true
                ? { disableAllHooks: true }
                : {}),
              ...(Object.keys(projectSettings).length
                ? { settings: projectSettings }
                : {}),
            },
          },
          {
            path: localPath,
            sections: {
              hooks: localHooks,
              ...(localFile.disableAllHooks === true
                ? { disableAllHooks: true }
                : {}),
              ...(Object.keys(localProjectSettings).length
                ? { settings: localProjectSettings }
                : {}),
            },
          },
          ...(projectFiles.commandsSource ? [projectFiles.commandsSource] : []),
        ],
      };
    }),
  );
  const localProjects = Object.fromEntries(
    layers.flatMap(({ localFolder, localServers }) =>
      localFolder && Object.keys(localServers).length
        ? [[localFolder, { mcpServers: localServers }]]
        : [],
    ),
  );
  const sources = [
    ...layers.flatMap(layer => layer.sources),
    { path: globalPath, sections: { projects: localProjects } },
  ];
  return { userServers, userHooks, layers, sources };
}
