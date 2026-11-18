import type { McpScope, McpServer, McpTransport } from '@nesvo/contracts';

export const describeServer = (
  name: string,
  scope: McpScope,
  transport: McpTransport | null,
  problem: string | null,
): McpServer => ({
  key: (scope + ':' + name).slice(0, 400),
  name: name.slice(0, 300) || '?',
  scope,
  transport,
  summary: null,
  fingerprint: null,
  problem,
});
