import { Circle, RefreshCw } from 'lucide-react';
import { Button } from '@/shared/ui/button';

type Props = {
  connection: 'connecting' | 'ready' | 'unavailable';
  onRefresh: () => void;
};

export function HostStatus({ connection, onRefresh }: Props) {
  const label = {
    connecting: 'Łączenie z hostem…',
    ready: 'Połączono z lokalnym hostem',
    unavailable: 'Brak połączenia z hostem',
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
        aria-label="Odśwież połączenie"
        title="Odśwież połączenie"
        disabled={connection === 'connecting'}
        onClick={onRefresh}
      >
        <RefreshCw />
      </Button>
    </div>
  );
}
