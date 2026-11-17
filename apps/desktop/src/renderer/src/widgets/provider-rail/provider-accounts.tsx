import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from 'cn';
import { providers, type Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { UsageDetails } from './usage-details';
import { useUsageClock } from './use-usage-clock';
import type { UsageState } from './usage-state';

type Props = {
  hostId: string;
  computerName: string;
  connected: boolean;
  states: Record<Provider, UsageState>;
  onRefresh: () => void;
  shown?: Provider | 'all';
  className?: string;
  children?: ReactNode;
};

export function ProviderAccounts({
  hostId,
  computerName,
  connected,
  states,
  onRefresh,
  shown = 'all',
  className,
  children,
}: Props) {
  const now = useUsageClock();
  const loading = providers.some(provider => states[provider].loading);
  return (
    <div data-host-id={hostId} className={className}>
      <header className="mb-2 flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold">
          Limits
          <span
            className="ml-1.5 font-normal text-muted-foreground"
            title={computerName}
          >
            {computerName}
            {connected ? '' : ' · Offline'}
          </span>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label="Refresh limits"
          title="Refresh limits"
          disabled={!connected || loading}
          onClick={onRefresh}
        >
          <RefreshCw
            className={cn(
              'size-3',
              loading && 'animate-spin motion-reduce:animate-none',
            )}
          />
        </Button>
      </header>
      {children}
      <div className="divide-y">
        {providers
          .filter(provider => shown === 'all' || shown === provider)
          .map(provider => (
            <UsageDetails
              key={provider}
              provider={provider}
              state={states[provider]}
              connected={connected}
              now={now}
            />
          ))}
      </div>
    </div>
  );
}
