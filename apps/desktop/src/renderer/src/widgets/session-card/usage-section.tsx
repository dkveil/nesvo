import { cn } from '@/shared/lib/cn';
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
import { Meter } from '@/shared/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { cardRowProps } from './card-row';

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
        return (
          <Tooltip key={provider}>
            <TooltipTrigger asChild>
              <div
                tabIndex={0}
                {...cardRowProps}
                data-usage-row={provider}
                data-usage-state={indicator}
                className="focus-ring col-span-3 grid h-6 grid-cols-subgrid items-center rounded-control px-2 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                  <ProviderGlyph
                    provider={provider}
                    className="size-3.5 text-current"
                  />
                  <span className="truncate">
                    {providerNames[provider]} weekly
                  </span>
                </span>
                <Meter
                  label={`Weekly ${providerNames[provider]} limit`}
                  value={left}
                  stale={faded}
                  aria-valuetext={`${formatPercent(left)} left${faded ? ', last observation' : ''}`}
                />
                <span className="text-right font-semibold tabular-nums">
                  {formatPercent(Math.round(left))}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent
              variant="panel"
              side="left"
              sideOffset={12}
              collisionPadding={12}
            >
              <IndicatorTooltip
                provider={provider}
                state={states[provider]}
                indicator={indicator}
                now={now}
              />
            </TooltipContent>
          </Tooltip>
        );
      })}
    </section>
  );
}
