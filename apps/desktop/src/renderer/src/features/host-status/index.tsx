import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';

type Props = {
  connection: 'connecting' | 'ready' | 'unavailable';
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
  name = 'Local',
  local = true,
}: Props) {
  const label = {
    connecting: 'Connecting to host…',
    ready: local ? 'Connected to local host' : `Connected to ${name}`,
    unavailable: `${name} is offline`,
  }[connection];
  return (
    <StatusMessage tone={connectionTones[connection]}>{label}</StatusMessage>
  );
}
