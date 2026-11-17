import { RefreshCw } from 'lucide-react';
import { IconButton } from '@/shared/ui/icon-button';
import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';

type Props = {
  connection: 'connecting' | 'ready' | 'unavailable';
  onRefresh: () => void;
  name?: string;
  local?: boolean;
};

const connectionTones: Record<Props['connection'], StatusTone> = {
  connecting: 'loading',
  ready: 'success',
  unavailable: 'warning',
};

export function HostStatus({
  connection,
  onRefresh,
  name = 'Local',
  local = true,
}: Props) {
  const label = {
    connecting: 'Connecting to host…',
    ready: local ? 'Connected to local host' : `Connected to ${name}`,
    unavailable: `${name} is offline`,
  }[connection];
  return (
    <div className="flex items-center gap-1.5">
      <StatusMessage tone={connectionTones[connection]}>{label}</StatusMessage>
      <IconButton
        size={24}
        label="Refresh connection"
        disabled={connection === 'connecting'}
        onClick={onRefresh}
      >
        <RefreshCw />
      </IconButton>
    </div>
  );
}
