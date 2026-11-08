import { Circle, RefreshCw } from 'lucide-react';
import { Button } from '@/shared/ui/button';

type Props = {
  connection: 'connecting' | 'ready' | 'unavailable';
  onRefresh: () => void;
  name?: string;
  local?: boolean;
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
    <div className="flex items-center gap-2">
      <span
        role="status"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        title={label}
      >
        <Circle
          className={connection === 'ready' ? 'size-2 fill-current' : 'size-2'}
          aria-hidden="true"
        />
        <span>{label}</span>
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Refresh connection"
        title="Refresh connection"
        disabled={connection === 'connecting'}
        onClick={onRefresh}
      >
        <RefreshCw />
      </Button>
    </div>
  );
}
