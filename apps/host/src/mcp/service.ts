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
  fingerprints: Record<string, string>;
  hooks: boolean;
};

const discoverEntries = (
  provider: Provider,
  directory: string,
  signal?: AbortSignal,
) =>
  provider === 'Codex'
    ? discoverCodexServers(signal)
    : discoverClaudeServers(directory, signal);

const entriesByKey = async (
  provider: Provider,
  directory: string,
  signal?: AbortSignal,
): Promise<Map<string, McpEntry>> => {
  const { entries } = await discoverEntries(provider, directory, signal);
  return new Map(entries.map(entry => [entry.server.key, entry]));
};

export const listMcpServers = async (
  provider: Provider,
  directory: string,
  signal?: AbortSignal,
): Promise<McpServerList> => {
  const { entries, issues } = await discoverEntries(
    provider,
    directory,
    signal,
  );
  return { provider, servers: entries.map(entry => entry.server), issues };
};

export const resolveMcpSelection = async (
  provider: Provider,
  directory: string,
  selection: McpSelection,
  signal?: AbortSignal,
): Promise<SessionMcp> => {
  if (!selection.servers.length) return { servers: [], hooks: selection.hooks };
  const entries = await entriesByKey(provider, directory, signal);
  return {
    servers: selection.servers.map(key => {
      const name = mcpServerNameOf(key);
      const server = entries.get(key)?.server;
      if (!server)
        throw new McpError(
          `The MCP server "${name}" is not configured for ${provider} in this folder. Refresh the list and try again.`,
        );
      if (server.problem || !server.fingerprint)
        throw new McpError(
          `The MCP server "${name}" cannot be enabled. ${server.problem ?? ''}`.trim(),
        );
      return { key, fingerprint: server.fingerprint };
    }),
    hooks: selection.hooks,
  };
};

export const prepareTurnMcp = async (
  provider: Provider,
  directory: string,
  mcp: SessionMcp,
  signal?: AbortSignal,
): Promise<TurnMcp> => {
  const turn: TurnMcp = { definitions: {}, fingerprints: {}, hooks: mcp.hooks };
  if (!mcp.servers.length) return turn;
  const entries = await entriesByKey(provider, directory, signal);
  for (const { key, fingerprint } of mcp.servers) {
    const name = mcpServerNameOf(key);
    const entry = entries.get(key);
    if (!entry)
      throw new McpError(
        `The MCP server "${name}" is no longer configured on this computer. Review the MCP selection. No provider turn was started.`,
      );
    if (
      entry.server.problem ||
      entry.server.fingerprint !== fingerprint ||
      (provider === 'Claude Code' && !entry.definition)
    )
      throw new McpError(
        `The MCP server "${name}" changed since it was enabled. Review it in the MCP menu and enable it again. No provider turn was started.`,
      );
    if (entry.definition) turn.definitions[name] = entry.definition;
    turn.fingerprints[name] = fingerprint;
  }
  return turn;
};
