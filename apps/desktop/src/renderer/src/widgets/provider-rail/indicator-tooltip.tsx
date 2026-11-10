import type { Provider } from '@/entities/session';
import {
  formatPercent,
  formatShortReset,
  remainingPercent,
  type IndicatorState,
  type UsageState,
} from './usage-state';

type Props = {
  provider: Provider;
  state: UsageState;
  indicator: IndicatorState;
};

const stateLabels: Record<IndicatorState, string> = {
  current: 'Current observation',
  stale: 'Stale · refresh to verify',
  offline: 'Offline · last observation',
  unavailable: 'Limits unavailable',
  checking: 'Checking limits…',
};

export function IndicatorTooltip({ provider, state, indicator }: Props) {
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
