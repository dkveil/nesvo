import { useEffect, useState } from 'react';
import { Circle, RefreshCw } from 'lucide-react';
import { Button } from '@/shared/ui/button';

type Connection = 'connecting' | 'ready' | 'unavailable';

export function HostStatus() {
  const [connection, setConnection] = useState<Connection>('connecting');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    window.nesvo.health().then(
      () => {
        if (active) setConnection('ready');
      },
      () => {
        if (active) setConnection('unavailable');
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
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
        <span className="hidden lg:inline">{label}</span>
        <span className="lg:hidden">
          {connection === 'ready'
            ? 'Połączono'
            : connection === 'connecting'
              ? 'Łączenie…'
              : 'Brak hosta'}
        </span>
        <span className="sr-only lg:hidden">{label}</span>
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Odśwież połączenie"
        title="Odśwież połączenie"
        disabled={connection === 'connecting'}
        onClick={() => {
          setConnection('connecting');
          setAttempt(value => value + 1);
        }}
      >
        <RefreshCw />
      </Button>
    </div>
  );
}
