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
  const layers = await Promise.all(
    [...folders].reverse().map(async folder => {
      const [config, hookFile] = await Promise.all([
        configTable(
          join(folder, '.codex', 'config.toml'),
          projectIssues,
          signal,
        ),
        configTable(
          join(folder, '.codex', 'hooks.json'),
          projectIssues,
          signal,
        ),
      ]);
      return {
        folder,
        servers: section(config, 'mcp_servers', projectIssues),
        localServers: {},
        hooks: section(config, 'hooks', projectIssues),
        localHooks: section(hookFile, 'hooks', projectIssues),
        hooksDisabled: false,
      };
    }),
  );
  return { userServers, userHooks, layers };
}
