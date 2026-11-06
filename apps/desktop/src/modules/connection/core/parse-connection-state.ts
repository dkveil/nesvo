import type { ConnectionState, ConnectionStatus } from '../contracts/connection-state';

const STATUSES: readonly ConnectionStatus[] = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
];

const isStatus = (value: unknown): value is ConnectionStatus =>
  typeof value === 'string' && STATUSES.includes(value as ConnectionStatus);

export const parseConnectionState = (value: unknown): ConnectionState | null => {
  if (!value || typeof value !== 'object') return null;
  const { status, message, attempt } = value as Record<string, unknown>;
  if (!isStatus(status)) return null;
  return {
    status,
    message: typeof message === 'string' ? message : null,
    attempt: typeof attempt === 'number' ? attempt : 0,
  };
};
