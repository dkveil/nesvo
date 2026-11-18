import type { McpServerList, Provider } from '@nesvo/contracts';
import { discoverClaudeServers } from './claude-servers';
import { discoverCodexServers } from './codex-servers';

export const listMcpServers = async (
  provider: Provider,
  directory: string,
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<McpServerList> => {
  const { servers, issues } =
    provider === 'Codex'
      ? await discoverCodexServers(signal, profileDirectory)
      : await discoverClaudeServers(directory, signal, profileDirectory);
  return { provider, servers, issues, configuration: 'native' };
};
