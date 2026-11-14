import { Tooltip } from 'radix-ui';
import { cn } from 'cn';
import { ProviderGlyph, providers, type Provider } from '@/entities/session';
import { IndicatorTooltip } from '@/widgets/provider-rail/indicator-tooltip';
import {
  formatPercent,
  indicatorStateOf,
  remainingPercent,
  type UsageState,
  type UsageWindow,
} from '@/widgets/provider-rail/usage-state';
import { useUsageClock } from '@/widgets/provider-rail/use-usage-clock';
import { cardSection } from '@/shared/ui/card-row-styles';

type Props = {
  states: Record<Provider, UsageState>;
  connected: boolean;
};

const WEEK_MINUTES = 10_080;

const providerNames: Record<Provider, string> = {
  'Claude Code': 'Claude',
  Codex: 'Codex',
};

const weeklyWindow = (state: UsageState) =>
  state.data?.status === 'ready' && !state.error
    ? state.data.windows
        .filter(window => window.windowMinutes === WEEK_MINUTES)
        .reduce<UsageWindow | undefined>(
          (most, window) =>
            !most || window.usedPercent > most.usedPercent ? window : most,
          undefined,
        )
    : undefined;

export function UsageSection({ states, connected }: Props) {
  const now = useUsageClock();
  const rows = providers.flatMap(provider => {
    const window = weeklyWindow(states[provider]);
    return window
      ? [
          {
            provider,
            window,
            indicator: indicatorStateOf(
              states[provider],
              window,
              connected,
              now,
            ),
          },
        ]
      : [];
  });
  if (rows.length === 0) return null;
  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={150}>
      <section
        aria-label="Usage"
        className={cn(
          cardSection,
          'grid grid-cols-[minmax(0,auto)_minmax(3rem,1fr)_2.25rem] gap-x-3 py-2',
        )}
      >
        {rows.map(({ provider, window, indicator }) => {
          const left = remainingPercent(window);
          const faded = indicator === 'stale' || indicator === 'offline';
          const label = `Weekly ${providerNames[provider]} limit`;
          return (
            <Tooltip.Root key={provider}>
              <Tooltip.Trigger asChild>
                <div
                  tabIndex={0}
                  data-card-row
                  data-usage-row={provider}
                  data-usage-state={indicator}
                  className="col-span-3 grid h-6 grid-cols-subgrid items-center rounded-md px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <ProviderGlyph
                      provider={provider}
                      className="size-3.5 text-current"
                    />
                    <span className="truncate">Weekly</span>
                  </span>
                  <span
                    role="progressbar"
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={left}
                    aria-valuetext={`${formatPercent(left)} left${faded ? ', last observation' : ''}`}
                    className={cn(
                      'relative h-0.75 overflow-hidden rounded-full bg-(--usage-ring-track)',
                      faded && 'opacity-50',
                    )}
                  >
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-foreground/85 transition-[width] duration-300 ease-out"
                      style={{ width: `${left}%` }}
                    />
                  </span>
                  <span className="text-right font-semibold tabular-nums">
                    {formatPercent(Math.round(left))}
                  </span>
                </div>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  side="left"
                  align="center"
                  sideOffset={12}
                  collisionPadding={12}
                  className="glass-popover z-50 w-72 rounded-md border px-3 py-2 text-xs text-popover-foreground"
                >
                  <IndicatorTooltip
                    provider={provider}
                    state={states[provider]}
                    indicator={indicator}
                    now={now}
                  />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          );
        })}
      </section>
    </Tooltip.Provider>
  );
}
