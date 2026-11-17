import { createHash } from 'node:crypto';
import {
  MCP_SERVER_NAME_PATTERN,
  mcpLimits,
  type McpScope,
  type McpServer,
  type McpTransport,
} from '@nesvo/contracts';

export type McpEndpoint = {
  transport: McpTransport;
  command: string | null;
  url: string | null;
};

export type McpEntry = {
  server: McpServer;
  definition: Record<string, unknown> | null;
};

const UNSAFE_NAME_PROBLEM =
  'This server name cannot be passed to the provider safely. Use letters, digits, hyphens or underscores.';

const withoutQuery = (url: string): string => url.split(/[?#]/)[0] ?? '';

const commandName = (command: string): string | null => {
  const trimmed = command.trim();
  const quoted = /^"([^"]+)"/.exec(trimmed)?.[1];
  const head = quoted ?? trimmed.split(/\s+/)[0] ?? '';
  const name = head.split(/[\\/]/).at(-1) ?? '';
  return name ? name.slice(0, mcpLimits.summary) : null;
};

const urlHost = (url: string): string | null => {
  try {
    const host = new URL(url).host;
    return host ? host.slice(0, mcpLimits.summary) : null;
  } catch {
    return null;
  }
};

export const endpointFingerprint = (endpoint: McpEndpoint): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        endpoint.transport,
        endpoint.command,
        endpoint.url === null ? null : withoutQuery(endpoint.url),
      ]),
    )
    .digest('hex');

export const describeServer = ({
  name,
  scope,
  endpoint,
  problem,
}: {
  name: string;
  scope: McpScope;
  endpoint: McpEndpoint | null;
  problem: string | null;
}): McpServer => {
  const nameProblem = MCP_SERVER_NAME_PATTERN.test(name)
    ? null
    : UNSAFE_NAME_PROBLEM;
  const finalProblem = problem ?? nameProblem;
  return {
    key: `${scope}:${name}`.slice(0, 400),
    name: name.slice(0, 300) || '?',
    scope,
    transport: endpoint?.transport ?? null,
    summary: !endpoint
      ? null
      : endpoint.transport === 'stdio'
        ? endpoint.command && commandName(endpoint.command)
        : endpoint.url && urlHost(endpoint.url),
    fingerprint:
      endpoint && !finalProblem ? endpointFingerprint(endpoint) : null,
    problem: finalProblem,
  };
};
