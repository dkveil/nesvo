import { cn } from 'cn';
import { providers, type Provider } from '@/entities/session';
import {
  formatPercent,
  isStaleUsage,
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
            stale: isStaleUsage(states[provider].data, connected, now),
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
        'grid grid-cols-[minmax(0,auto)_minmax(3rem,1fr)_2.25rem] gap-x-3',
      )}
    >
      {rows.map(({ provider, window, stale }) => {
        const used = Math.min(100, Math.max(0, window.usedPercent));
        const label = `Weekly · ${providerNames[provider]}`;
        return (
          <div
            key={provider}
            data-usage-row={provider}
            title={`${provider} · ${window.label}${stale ? ' · last observation' : ''}`}
            className="col-span-3 grid h-7 grid-cols-subgrid items-center px-2.5 text-xs"
          >
            <span className="min-w-0 truncate text-muted-foreground">
              {label}
            </span>
            <span
              role="progressbar"
              aria-label={`${label} used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={used}
              aria-valuetext={`${formatPercent(used)} used${stale ? ', stale observation' : ''}`}
              className={cn(
                'relative h-0.75 overflow-hidden rounded-full bg-(--usage-ring-track)',
                stale && 'opacity-50',
              )}
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-foreground/85 transition-[width] duration-300 ease-out"
                style={{ width: `${used}%` }}
              />
            </span>
            <span className="text-right font-semibold tabular-nums">
              {formatPercent(Math.round(used))}
            </span>
          </div>
        );
      })}
    </section>
  );
}
