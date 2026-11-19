import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { providers, type Provider } from '@/entities/session';
import { IconButton } from '@/shared/ui/icon-button';
import { SectionLabel } from '@/shared/ui/section-label';
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
      <SectionLabel
        as="h2"
        className="mb-2 px-0"
        action={
          <IconButton
            label="Refresh limits"
            size={24}
            disabled={!connected || loading}
            onClick={onRefresh}
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          </IconButton>
        }
      >
        Limits
        <span className="truncate font-normal" title={computerName}>
          {computerName}
          {connected ? '' : ' · Offline'}
        </span>
      </SectionLabel>
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
