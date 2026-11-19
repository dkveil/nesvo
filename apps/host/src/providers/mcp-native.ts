import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  McpConnectionAction,
  McpConnectionStatus,
} from '@nesvo/contracts';

export type NativeMcpStatus = {
  status: McpConnectionStatus;
  logout: boolean;
  waiting: boolean;
  tools?: string[];
};

export type NativeMcpAction = Exclude<McpConnectionAction, 'reconnect'>;

export function mcpRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function claudeMcpStatus(row: Record<string, unknown>): NativeMcpStatus {
  const status = row.status;
  return {
    status:
      status === 'connected'
        ? 'connected'
        : status === 'needs-auth'
          ? 'needs-authorization'
          : status === 'failed'
            ? 'failed'
            : 'unavailable',
    logout: false,
    waiting: status === 'pending' || status === 'connecting',
    ...(Array.isArray(row.tools) && row.tools.length <= 100
      ? {
          tools: row.tools
            .map(tool => mcpRecord(tool)?.name)
            .filter((name): name is string => typeof name === 'string'),
        }
      : {}),
  };
}

export function codexMcpStatus(row: Record<string, unknown>): NativeMcpStatus {
  const runtime = row.runtimeStatus;
  const requiresAuth =
    runtime === 'authenticationRequired' ||
    (row.authStatus === 'notLoggedIn' &&
      (runtime === 'failed' || runtime == null));
  const status =
    runtime === 'connected'
      ? 'connected'
      : requiresAuth
        ? 'needs-authorization'
        : runtime === 'failed' || (runtime == null && row.toolsError != null)
          ? 'failed'
          : runtime == null && mcpRecord(row.serverInfo)
            ? 'connected'
            : 'unavailable';
  return {
    status,
    logout: row.authStatus === 'oAuth',
    waiting: runtime === 'notStarted' || runtime === 'starting',
  };
}

export function mcpStatusMap(
  value: unknown,
  mapStatus: (row: Record<string, unknown>) => NativeMcpStatus,
) {
  if (!Array.isArray(value)) throw new Error('Invalid MCP status result.');
  const statuses = new Map<string, NativeMcpStatus>();
  for (const item of value) {
    const row = mcpRecord(item);
    if (typeof row?.name === 'string' && row.name.length <= 300)
      statuses.set(row.name, mapStatus(row));
  }
  return statuses;
}

export async function finishNativeMcpCommand(
  process: {
    child: ChildProcessWithoutNullStreams;
    closed: Promise<{ code: number | null; error: Error | null }>;
    stop(): Promise<void>;
  },
  signal: AbortSignal,
) {
  process.child.stdout.resume();
  process.child.stderr.resume();
  process.child.stdin.end();
  const stop = () => void process.stop();
  const timeout = setTimeout(stop, 240_000);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    const result = await process.closed;
    return !signal.aborted && !result.error && result.code === 0;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', stop);
    await process.stop();
  }
}
