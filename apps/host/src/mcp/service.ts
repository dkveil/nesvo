import {
  mcpServerNameOf,
  type McpSelection,
  type McpServerList,
  type Provider,
  type SessionMcp,
} from '@nesvo/contracts';
import { discoverClaudeServers } from './claude-servers';
import { discoverCodexServers } from './codex-servers';
import type { McpEntry } from './server-summary';

export class McpError extends Error {}

export type TurnMcp = {
  definitions: Record<string, Record<string, unknown>>;
  hooks: boolean;
};

const discoverEntries = (
  key: Buffer,
  provider: Provider,
  directory: string,
  signal?: AbortSignal,
  profileDirectory?: string,
) =>
  provider === 'Codex'
    ? discoverCodexServers(key, signal, profileDirectory)
    : discoverClaudeServers(key, directory, signal, profileDirectory);

const entriesByKey = async (
  key: Buffer,
  provider: Provider,
  directory: string,
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<Map<string, McpEntry>> => {
  const { entries } = await discoverEntries(key, provider, directory, signal, profileDirectory);
  return new Map(entries.map(entry => [entry.server.key, entry]));
};

export const listMcpServers = async (
  key: Buffer,
  provider: Provider,
  directory: string,
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<McpServerList> => {
  const { entries, issues } = await discoverEntries(
    key,
    provider,
    directory,
    signal,
    profileDirectory,
  );
  return { provider, servers: entries.map(entry => entry.server), issues };
};

export const resolveMcpSelection = async (
  key: Buffer,
  provider: Provider,
  directory: string,
  selection: McpSelection,
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<SessionMcp> => {
  if (!selection.servers.length) return { servers: [], hooks: selection.hooks };
  const entries = await entriesByKey(key, provider, directory, signal, profileDirectory);
  return {
    servers: selection.servers.map(serverKey => {
      const name = mcpServerNameOf(serverKey);
      const server = entries.get(serverKey)?.server;
      if (!server)
        throw new McpError(
          `The MCP server "${name}" is not configured for ${provider} in this folder. Refresh the list and try again.`,
        );
      if (server.problem || !server.fingerprint)
        throw new McpError(
          `The MCP server "${name}" cannot be enabled. ${server.problem ?? ''}`.trim(),
        );
      return { key: serverKey, fingerprint: server.fingerprint };
    }),
    hooks: selection.hooks,
  };
};

export const prepareTurnMcp = async (
  key: Buffer,
  provider: Provider,
  directory: string,
  mcp: SessionMcp,
  signal?: AbortSignal,
  profileDirectory?: string,
): Promise<TurnMcp> => {
  const turn: TurnMcp = { definitions: {}, hooks: mcp.hooks };
  if (!mcp.servers.length) return turn;
  const entries = await entriesByKey(key, provider, directory, signal, profileDirectory);
  for (const { key: serverKey, fingerprint } of mcp.servers) {
    const name = mcpServerNameOf(serverKey);
    const entry = entries.get(serverKey);
    if (!entry)
      throw new McpError(
        `The MCP server "${name}" is no longer configured on this computer. Review the MCP selection. No provider turn was started.`,
      );
    if (
      entry.server.problem ||
      entry.server.fingerprint !== fingerprint ||
      !entry.definition
    )
      throw new McpError(
        `The MCP server "${name}" changed since it was enabled. Review it in the MCP menu and enable it again. No provider turn was started.`,
      );
    turn.definitions[name] = entry.definition;
  }
  return turn;
};
