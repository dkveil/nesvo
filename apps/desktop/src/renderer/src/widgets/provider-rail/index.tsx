import { useRef, useState } from 'react';
import { ChevronLeft, UserRound } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { providers, type Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '@/shared/ui/popover';
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          role={layout === 'account' ? undefined : 'group'}
          aria-label={layout === 'account' ? undefined : 'Provider limits'}
          data-host-id={hostId}
          className={cn(
            'flex',
            layout === 'row' && 'items-center gap-0.5',
            layout === 'column' && 'flex-col items-center gap-1',
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
            <PopoverTrigger asChild>
              <IconButton
                label="Account and limits"
                tone="sidebar"
                onClick={event => {
                  returnFocus.current = event.currentTarget;
                  setSelected('all');
                }}
              >
                <UserRound />
              </IconButton>
            </PopoverTrigger>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side={popoverSide}
        align={popoverSide === 'top' ? 'start' : 'end'}
        sideOffset={10}
        size="md"
        scroll
        aria-label="Account and limits"
        onCloseAutoFocus={event => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
        data-host-id={hostId}
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
              className="mb-2 -ml-1.5 text-muted-foreground"
              onClick={() => setSelected('all')}
            >
              <ChevronLeft />
              All accounts
            </Button>
          )}
        </ProviderAccounts>
      </PopoverContent>
    </Popover>
  );
}
