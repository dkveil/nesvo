import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpScope } from '@nesvo/contracts';
import { describeServer } from './server-summary';
import { configTable, section } from './scoped-config';

const serverSchema = z.looseObject({
  command: z.string().min(1).max(4096).optional(),
  url: z.string().min(1).max(8192).optional(),
  enabled: z.boolean().optional(),
});

export const codexHome = (): string =>
  process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');

export function codexServer(name: string, value: unknown, scope: McpScope) {
  const { command, url, enabled } = serverSchema.safeParse(value).data ?? {};
  const transport = command && !url ? 'stdio' : url && !command ? 'http' : null;
  const problem =
    enabled === false
      ? 'Disabled in the provider configuration.'
      : !transport
        ? 'Server transport could not be identified.'
        : null;
  return describeServer(name, scope, transport, problem);
}

export async function readCodexConfiguration(
  folders: string[],
  issues: string[],
  projectIssues: string[],
  signal?: AbortSignal,
  profileDirectory?: string,
) {
  const home = profileDirectory ?? codexHome();
  const [user, userHookFile] = await Promise.all([
    configTable(join(home, 'config.toml'), issues, signal, 4 * 1024 * 1024),
    configTable(join(home, 'hooks.json'), issues, signal),
  ]);
  const userServers = section(user, 'mcp_servers', issues);
  const userHooks = {
    config: section(user, 'hooks', issues),
    file: section(userHookFile, 'hooks', issues),
  };
  const repositoryRoot = folders.at(-1);
  const layers = await Promise.all(
    [...folders].reverse().map(async folder => {
      const configPath = join(folder, '.codex', 'config.toml');
      const hooksPath = join(folder, '.codex', 'hooks.json');
      const [config, hookFile] = await Promise.all([
        configTable(
          configPath,
          projectIssues,
          signal,
          undefined,
          repositoryRoot,
        ),
        configTable(
          hooksPath,
          projectIssues,
          signal,
          undefined,
          repositoryRoot,
        ),
      ]);
      const servers = section(config, 'mcp_servers', projectIssues);
      const hooks = section(config, 'hooks', projectIssues);
      const localHooks = section(hookFile, 'hooks', projectIssues);
      return {
        servers,
        localServers: {},
        hooks,
        localHooks,
        hooksDisabled: false,
        sources: [
          { path: configPath, sections: { mcp_servers: servers, hooks } },
          { path: hooksPath, sections: { hooks: localHooks } },
        ],
      };
    }),
  );
  return {
    userServers,
    userHooks,
    layers,
    sources: layers.flatMap(layer => layer.sources),
  };
}
