import type { StatusBadgeTone } from '../../../shared/components/status-badge';
import type { ConnectionState, ConnectionStatus } from '../contracts/connection-state';

const LABELS: Record<ConnectionStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  failed: 'Connection failed',
};

const TONES: Record<ConnectionStatus, StatusBadgeTone> = {
  idle: 'neutral',
  connecting: 'accent',
  connected: 'positive',
  reconnecting: 'warning',
  failed: 'critical',
};

export const describeConnection = ({ status, attempt }: ConnectionState) => ({
  label:
    status === 'reconnecting' && attempt > 1 ? `${LABELS[status]} (${attempt})` : LABELS[status],
  tone: TONES[status],
});
