import {
  mcpServerNameOf,
  type McpScope,
  type McpTransport,
  type MessageMcp,
} from '@nesvo/contracts';

export const scopeLabels: Record<McpScope, string> = {
  user: 'User',
  project: 'Project',
  local: 'Local',
};

export const transportLabels: Record<McpTransport, string> = {
  stdio: 'stdio',
  http: 'HTTP',
  sse: 'SSE',
};

const sameServers = (left: string[], right: string[]) =>
  left.length === right.length && left.every(key => right.includes(key));

export function mcpChangeLabel(
  previous: MessageMcp,
  next: MessageMcp,
): string | null {
  const parts: string[] = [];
  if (!sameServers(previous.servers, next.servers))
    parts.push(
      next.servers.length
        ? `MCP servers: ${next.servers.map(mcpServerNameOf).join(', ')}`
        : 'MCP servers off',
    );
  if (previous.hooks !== next.hooks)
    parts.push(next.hooks ? 'Hooks on' : 'Hooks off');
  return parts.length ? parts.join(' · ') : null;
}
