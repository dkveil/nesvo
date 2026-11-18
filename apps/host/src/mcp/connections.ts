import type {
  McpConnectionAction,
  McpConnectionList,
  McpConnectionRequest,
  McpServer,
  Provider,
} from '@nesvo/contracts';
import { inspectClaudeMcp, runClaudeMcpAuth } from '../providers/claude';
import { inspectCodexMcp, runCodexMcpAuth } from '../providers/codex';
import { mcpRecord, type NativeMcpStatus } from '../providers/mcp-native';
import { profileEnvironment } from '../providers/profiles';
import { SessionError } from '../sessions/session-error';
import type { McpPolicy } from './service';

type ConnectionScope = {
  provider: Provider;
  directory: string;
  dataDirectory: string;
  profileDirectory?: string;
  includeRepository: boolean;
};

function connectionDefinition(value: unknown) {
  const definition = mcpRecord(value);
  if (!definition || definition.enabled === false) return;
  if (
    ['headers', 'http_headers', 'env'].some(key =>
      Object.hasOwn(definition, key),
    )
  )
    return;
  if (typeof definition.url === 'string') {
    try {
      const url = new URL(definition.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return;
    } catch {
      return;
    }
    return definition;
  }
  return typeof definition.command === 'string' ? definition : undefined;
}

function nativeInstruction(
  provider: Provider,
  server: McpServer,
  action: McpConnectionAction,
  remote: boolean,
) {
  if (action === 'reconnect')
    return provider === 'Claude Code'
      ? 'Run claude in the same folder and profile, then open /mcp, select this server and choose Reconnect.'
      : 'Restart Codex in the same folder and profile, then run /mcp to verify the connection.';
  const cli = provider === 'Claude Code' ? 'claude' : 'codex';
  const command = action === 'authorize' ? 'login' : 'logout';
  const terminal = remote ? ' on this computer' : '';
  const flag = remote && command === 'login' ? ' --no-browser' : '';
  return `In the same folder and provider profile${terminal}, run ${cli} mcp ${command} ${server.name}${flag}.`;
}

export async function mcpConnections(
  policy: McpPolicy,
  scope: ConnectionScope,
  input: McpConnectionRequest,
  signal: AbortSignal,
): Promise<McpConnectionList> {
  const {
    provider,
    directory,
    dataDirectory,
    profileDirectory,
    includeRepository,
  } = scope;
  const inventory = await policy.connectionInventory(
    provider,
    directory,
    signal,
    profileDirectory,
    includeRepository,
  );
  const environment = profileEnvironment(provider, profileDirectory);
  const claude = provider === 'Claude Code';
  const definitions = Object.fromEntries(
    inventory.servers.flatMap(server => {
      const definition = connectionDefinition(
        inventory.definitions[server.name],
      );
      return definition ? [[server.name, definition]] : [];
    }),
  );
  const projectServers = Object.fromEntries(
    inventory.servers.flatMap(server =>
      server.scope !== 'user' && Object.hasOwn(definitions, server.name)
        ? [[server.name, definitions[server.name]]]
        : [],
    ),
  );
  const names = new Set(Object.keys(definitions));
  const inspect = (reconnect?: string) =>
    claude
      ? inspectClaudeMcp(
          directory,
          dataDirectory,
          definitions,
          signal,
          environment,
          reconnect,
        )
      : inspectCodexMcp(
          directory,
          names,
          signal,
          environment,
          reconnect,
          projectServers,
        );
  let notice: string | undefined;
  const statuses = async (reconnect?: string) => {
    try {
      return names.size
        ? await inspect(reconnect)
        : new Map<string, NativeMcpStatus>();
    } catch {
      signal.throwIfAborted();
      notice = claude
        ? 'Claude Code could not report MCP status. In the same folder and profile, run claude and open /mcp.'
        : 'Codex could not report MCP status. In the same folder and profile, run codex and open /mcp.';
      return undefined;
    }
  };
  let current = (await statuses()) ?? new Map<string, NativeMcpStatus>();
  const actions = (server: McpServer): McpConnectionAction[] => {
    const native = current.get(server.name);
    if (!names.has(server.name) || !native) return [];
    const result: McpConnectionAction[] = [];
    if (native.status === 'needs-authorization') result.push('authorize');
    if (native.status === 'failed') result.push('reconnect');
    if (native.logout) result.push('logout');
    return result;
  };
  if (input.action) {
    const { kind, serverKey } = input.action;
    const server = inventory.servers.find(entry => entry.key === serverKey);
    if (!server || !actions(server).includes(kind))
      throw new SessionError(
        'invalid-request',
        'This MCP action is no longer available. Refresh the server status.',
      );
    const guide = nativeInstruction(provider, server, kind, !input.browser);
    if (kind === 'reconnect') {
      current = (await statuses(server.name)) ?? current;
      if (current.get(server.name)?.status !== 'connected') notice = guide;
    } else if (!input.browser) {
      notice = guide;
    } else {
      const verified = await policy.connectionInventory(
        provider,
        directory,
        signal,
        profileDirectory,
        includeRepository,
      );
      if (
        !verified.servers.some(entry => entry.key === server.key) ||
        JSON.stringify(verified.definitions[server.name]) !==
          JSON.stringify(inventory.definitions[server.name])
      )
        throw new SessionError(
          'invalid-request',
          'The MCP server configuration changed. Refresh the server status.',
        );
      const cwd = server.scope === 'user' ? dataDirectory : directory;
      let completed = false;
      try {
        completed = claude
          ? await runClaudeMcpAuth(cwd, kind, server.name, signal, environment)
          : await runCodexMcpAuth(
              cwd,
              kind,
              server.name,
              signal,
              environment,
              projectServers[server.name],
            );
      } catch {
        signal.throwIfAborted();
      }
      current = (await statuses()) ?? new Map<string, NativeMcpStatus>();
      if (!completed)
        notice =
          claude && kind === 'authorize'
            ? guide +
              ' If login is unavailable, run claude, open /mcp and select Authenticate for this server.'
            : guide;
    }
  }
  const allowedKeys = new Set(inventory.servers.map(server => server.key));
  return {
    provider,
    servers: inventory.candidates.map(server => {
      const observed = allowedKeys.has(server.key) && names.has(server.name);
      return {
        ...server,
        status:
          (observed ? current.get(server.name)?.status : undefined) ??
          'unavailable',
        actions: observed ? actions(server) : [],
      };
    }),
    notice,
  };
}
