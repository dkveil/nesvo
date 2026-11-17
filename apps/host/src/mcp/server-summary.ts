import { createHmac } from 'node:crypto';
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

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        key =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

export const definitionFingerprint = (
  key: Buffer,
  definition: unknown,
): string =>
  createHmac('sha256', key).update(canonicalJson(definition)).digest('hex');

export const describeServer = ({
  name,
  scope,
  endpoint,
  problem,
  fingerprint,
}: {
  name: string;
  scope: McpScope;
  endpoint: McpEndpoint | null;
  problem: string | null;
  fingerprint: string | null;
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
    fingerprint: endpoint && !finalProblem ? fingerprint : null,
    problem: finalProblem,
  };
};
