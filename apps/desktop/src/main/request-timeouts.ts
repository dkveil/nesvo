import { type HostRequest } from '@nesvo/contracts';

const WORKTREE_REQUEST_TIMEOUT_MS = 120_000;
const LONG_REQUEST_TIMEOUT_MS = 60_000;
const USAGE_REQUEST_TIMEOUT_MS = 40_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const longRequests = new Set<HostRequest['method']>([
  'health',
  'list-sessions',
  'list-reviews',
  'discover-skills',
  'start-workflow-task',
  'workflow-assistant-send',
  'act-on-pull-request',
]);

const providerRequests = new Set<HostRequest['method']>([
  'claude-status',
  'codex-status',
  'create-session',
  'list-conversations',
  'adopt-conversation',
  'list-mcp-servers',
  'set-session-mcp',
  'list-pull-requests',
  'read-pull-request',
  'read-pull-request-files',
  'read-pull-request-threads',
  'find-session-pull-request',
  'read-session-worktree',
]);

const createsWorktree = (method: HostRequest['method'], input: unknown) =>
  method === 'create-session' &&
  typeof input === 'object' &&
  input !== null &&
  'isolation' in input &&
  !!input.isolation;

export const requestTimeoutMs = (
  method: HostRequest['method'],
  input?: unknown,
) => {
  if (method === 'finish-session-worktree' || createsWorktree(method, input))
    return WORKTREE_REQUEST_TIMEOUT_MS;
  if (longRequests.has(method)) return LONG_REQUEST_TIMEOUT_MS;
  if (method === 'provider-usage') return USAGE_REQUEST_TIMEOUT_MS;
  if (providerRequests.has(method)) return PROVIDER_REQUEST_TIMEOUT_MS;
  return DEFAULT_REQUEST_TIMEOUT_MS;
};
