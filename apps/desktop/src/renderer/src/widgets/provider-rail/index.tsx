import { useEffect, useRef, useState } from 'react';
import { RefreshCw, UserRound } from 'lucide-react';
import { Popover, Tooltip } from 'radix-ui';
import { providers, type Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { providerMarks } from '@/features/new-thread/provider-mark';
import { UsageDetails } from './usage-details';
import { UsageRing } from './usage-ring';
import {
  allowanceLevel,
  formatPercent,
  formatShortReset,
  indicatorStateOf,
  observedWindow,
  remainingPercent,
  type IndicatorState,
  type UsageState,
} from './usage-state';

type Props = {
  hostId: string;
  computerName: string;
  connected: boolean;
  states: Record<Provider, UsageState>;
  onRefresh: () => void;
  compact?: boolean;
};

const REFRESH_CLOCK_MS = 15_000;

const stateLabels: Record<IndicatorState, string> = {
  current: 'Current observation',
  stale: 'Stale · refresh to verify',
  offline: 'Offline · last observation',
  unavailable: 'Limits unavailable',
  checking: 'Checking limits…',
};

function IndicatorTooltip({
  provider,
  state,
  indicator,
}: {
  provider: Provider;
  state: UsageState;
  indicator: IndicatorState;
}) {
  const windows =
    state.data?.status === 'ready' && !state.error ? state.data.windows : [];
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-medium">{provider}</span>
        <span className="text-muted-foreground">{stateLabels[indicator]}</span>
      </div>
      {windows.map(window => (
        <div
          key={window.id}
          className="flex items-baseline justify-between gap-4 tabular-nums"
        >
          <span className="min-w-0 truncate text-muted-foreground">
            {window.label}
          </span>
          <span className="shrink-0">
            {formatPercent(remainingPercent(window))} left
            {window.resetsAt && (
              <span className="text-muted-foreground">
                {' · resets '}
                {formatShortReset(window.resetsAt)}
              </span>
            )}
          </span>
        </div>
      ))}
      {!windows.length && (
        <p className="text-muted-foreground">
          {state.data?.detail ?? 'No quota values are reported right now.'}
        </p>
      )}
    </div>
  );
}

export function ProviderRail({
  hostId,
  computerName,
  connected,
  states,
  onRefresh,
  compact = false,
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
  const content = (
    <Popover.Portal>
      <Popover.Content
        side={compact ? 'bottom' : 'right'}
        align="end"
        sideOffset={10}
        collisionPadding={12}
        aria-label="Account and limits"
        onCloseAutoFocus={event => {
          if (!compact && returnFocus.current?.isConnected) {
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
              {!connected ? ' · Offline' : ''}
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
              className={`size-3.5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`}
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
  );
  if (compact)
    return (
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Account and limits"
            title="Account and limits"
            className="text-muted-foreground"
            onClick={() => setSelected('all')}
          >
            <UserRound className="size-4" />
          </Button>
        </Popover.Trigger>
        {content}
      </Popover.Root>
    );
  return (
    <aside
      aria-label="Provider limits"
      data-host-id={hostId}
      className="hidden w-(--usage-rail-width) shrink-0 flex-col items-center bg-(--usage-rail-background) pb-3 md:flex"
    >
      <div className="drag-region h-(--shell-topbar-height) w-full shrink-0" />
      <div className="flex-1" />
      <Tooltip.Provider delayDuration={250} skipDelayDuration={150}>
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Popover.Anchor asChild>
            <div className="flex flex-col items-center gap-2.5">
              {providers.map(provider => {
                const state = states[provider];
                const window = !state.error
                  ? observedWindow(state.data)
                  : undefined;
                const indicator = indicatorStateOf(
                  state,
                  window,
                  connected,
                  now,
                );
                const remaining = window ? remainingPercent(window) : null;
                const label = `${provider} limits: ${window ? `${window.label}, ${formatPercent(remaining ?? 0)} remaining${indicator === 'stale' ? ', stale' : ''}` : state.loading ? 'checking' : 'unavailable'}${!connected ? ', offline' : ''}`;
                return (
                  <Tooltip.Root key={provider}>
                    <Tooltip.Trigger asChild>
                      <button
                        type="button"
                        aria-label={label}
                        aria-haspopup="dialog"
                        aria-expanded={open && selected === provider}
                        data-provider-indicator={provider}
                        data-usage-state={indicator}
                        data-usage-stale={indicator === 'stale'}
                        className="grid size-10 place-items-center rounded-full outline-none transition-[background-color,scale] duration-150 ease-out hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97] aria-expanded:bg-sidebar-row-selected"
                        onClick={event => {
                          returnFocus.current = event.currentTarget;
                          setSelected(provider);
                          setOpen(true);
                        }}
                      >
                        <UsageRing
                          mark={providerMarks[provider]}
                          remaining={
                            indicator === 'unavailable' ? null : remaining
                          }
                          level={
                            remaining === null
                              ? null
                              : allowanceLevel(remaining)
                          }
                          state={indicator}
                        />
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        side="right"
                        align="center"
                        sideOffset={8}
                        collisionPadding={12}
                        className="z-50 w-80 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xl"
                      >
                        <IndicatorTooltip
                          provider={provider}
                          state={state}
                          indicator={indicator}
                        />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                );
              })}
              <Popover.Trigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Account and limits"
                  title="Account and limits"
                  className="mt-1 size-9 rounded-full text-muted-foreground"
                  onClick={event => {
                    returnFocus.current = event.currentTarget;
                    setSelected('all');
                  }}
                >
                  <UserRound className="size-4" />
                </Button>
              </Popover.Trigger>
            </div>
          </Popover.Anchor>
          {content}
        </Popover.Root>
      </Tooltip.Provider>
    </aside>
  );
}
