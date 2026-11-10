import { useEffect, useRef, useState } from 'react';
import { RefreshCw, UserRound } from 'lucide-react';
import { Popover, Tooltip } from 'radix-ui';
import { cn } from 'cn';
import { providers, type Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { UsageDetails } from './usage-details';
import { UsageIndicator, type UsageLayout } from './usage-indicator';
import type { UsageState } from './usage-state';

export type { UsageLayout } from './usage-indicator';

type Props = {
  hostId: string;
  computerName: string;
  connected: boolean;
  states: Record<Provider, UsageState>;
  onRefresh: () => void;
  layout: UsageLayout;
  popoverSide?: 'right' | 'bottom' | 'top';
};

const REFRESH_CLOCK_MS = 15_000;

export function ProviderUsage({
  hostId,
  computerName,
  connected,
  states,
  onRefresh,
  layout,
  popoverSide = 'right',
}: Props) {
  const [selected, setSelected] = useState<Provider | 'all'>('all');
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    const timer = window.setInterval(update, REFRESH_CLOCK_MS);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const loading = providers.some(provider => states[provider].loading);
  const openFrom = (trigger: HTMLButtonElement, provider: Provider) => {
    returnFocus.current = trigger;
    setSelected(provider);
    setOpen(true);
  };
  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={150}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div
            role={layout === 'account' ? undefined : 'group'}
            aria-label={layout === 'account' ? undefined : 'Provider limits'}
            data-host-id={hostId}
            className={cn(
              'flex',
              layout === 'column' && 'flex-col items-center gap-2.5',
              layout === 'row' && 'items-center gap-0.5',
              layout === 'bars' && 'flex-col gap-px',
            )}
          >
            {layout !== 'account' &&
              providers.map(provider => (
                <UsageIndicator
                  key={provider}
                  provider={provider}
                  state={states[provider]}
                  connected={connected}
                  now={now}
                  expanded={open && selected === provider}
                  layout={layout}
                  onOpen={trigger => openFrom(trigger, provider)}
                />
              ))}
            {layout !== 'bars' && (
              <Popover.Trigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Account and limits"
                  title="Account and limits"
                  className={cn(
                    'text-sidebar-muted-foreground',
                    layout === 'column' ? 'size-9 rounded-full' : 'size-7',
                  )}
                  onClick={event => {
                    returnFocus.current = event.currentTarget;
                    setSelected('all');
                  }}
                >
                  <UserRound className="size-4" />
                </Button>
              </Popover.Trigger>
            )}
          </div>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            side={popoverSide}
            align={popoverSide === 'top' ? 'start' : 'end'}
            sideOffset={10}
            collisionPadding={12}
            aria-label="Account and limits"
            onCloseAutoFocus={event => {
              if (returnFocus.current?.isConnected) {
                event.preventDefault();
                returnFocus.current.focus();
              }
            }}
            data-host-id={hostId}
            className="z-50 max-h-[min(40rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border bg-popover p-4 text-popover-foreground shadow-xl"
          >
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
            {selected !== 'all' && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="mb-3 px-0 text-muted-foreground"
                onClick={() => setSelected('all')}
              >
                All accounts
              </Button>
            )}
            <div className="divide-y">
              {providers
                .filter(provider => selected === 'all' || selected === provider)
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
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Tooltip.Provider>
  );
}
