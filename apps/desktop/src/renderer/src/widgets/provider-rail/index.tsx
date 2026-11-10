import { useRef, useState } from 'react';
import { UserRound } from 'lucide-react';
import { Popover, Tooltip } from 'radix-ui';
import { cn } from 'cn';
import { providers, type Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ProviderAccounts } from './provider-accounts';
import { useUsageClock } from './use-usage-clock';
import { UsageIndicator, type UsageLayout } from './usage-indicator';
import type { UsageState } from './usage-state';

export type { UsageLayout } from './usage-indicator';
export { ProviderAccounts } from './provider-accounts';

type Props = {
  hostId: string;
  computerName: string;
  connected: boolean;
  states: Record<Provider, UsageState>;
  onRefresh: () => void;
  layout: UsageLayout;
  popoverSide?: 'bottom' | 'top';
};

export function ProviderUsage({
  hostId,
  computerName,
  connected,
  states,
  onRefresh,
  layout,
  popoverSide = 'bottom',
}: Props) {
  const [selected, setSelected] = useState<Provider | 'all'>('all');
  const [open, setOpen] = useState(false);
  const now = useUsageClock();
  const returnFocus = useRef<HTMLButtonElement | null>(null);
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
            {layout === 'account' && (
              <Popover.Trigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Account and limits"
                  title="Account and limits"
                  className="size-7 text-sidebar-icon hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
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
            className="glass-popover z-50 max-h-[min(40rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-lg border p-4 text-popover-foreground"
          >
            <ProviderAccounts
              hostId={hostId}
              computerName={computerName}
              connected={connected}
              states={states}
              onRefresh={onRefresh}
              shown={selected}
            >
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
            </ProviderAccounts>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Tooltip.Provider>
  );
}
