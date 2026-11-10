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
      <header className="mb-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">Account and limits</h2>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            title={computerName}
          >
            {computerName}
            {connected ? '' : ' · Offline'}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 text-muted-foreground hover:text-foreground"
          aria-label="Refresh limits"
          title="Refresh limits"
          disabled={!connected || loading}
          onClick={onRefresh}
        >
          <RefreshCw
            className={cn(
              'size-3.5',
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
