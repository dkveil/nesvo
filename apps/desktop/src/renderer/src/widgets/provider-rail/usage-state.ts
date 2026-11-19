import type { ProviderUsage } from '@nesvo/contracts';

export type UsageState = {
  data?: ProviderUsage;
  loading: boolean;
  error: boolean;
};

export type UsageWindow = ProviderUsage['windows'][number];

export type IndicatorState =
  'current' | 'stale' | 'offline' | 'unavailable' | 'checking';

export type AllowanceLevel = 'high' | 'medium' | 'low';

const STALE_AFTER_MS = 300_000;

export const formatPercent = (value: number) =>
  `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)}%`;

const localDateTime = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
export const formatResetTime = (value: string) =>
  localDateTime.format(new Date(value));
export const usageWindowLabel = (label: string) =>
  label.replace(/^Codex · /, '');

export function resetCountdown(value: string, now: number) {
  const minutes = Math.ceil((Date.parse(value) - now) / 60_000);
  if (minutes <= 0) return 'Reported reset passed';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const remainder = minutes % 60;
  if (days)
    return 'Resets in ' + days + ' d' + (hours ? ' ' + hours + ' h' : '');
  if (hours)
    return (
      'Resets in ' + hours + ' h' + (remainder ? ' ' + remainder + ' min' : '')
    );
  return 'Resets in ' + remainder + ' min';
}

export const isStaleUsage = (
  data: ProviderUsage | undefined,
  connected: boolean,
  now: number,
) =>
  !!data &&
  (!connected ||
    now - Date.parse(data.checkedAt) > STALE_AFTER_MS ||
    data.windows.some(
      window => window.resetsAt !== null && Date.parse(window.resetsAt) <= now,
    ));

export const observedWindow = (data?: ProviderUsage) =>
  data?.status === 'ready'
    ? data.windows.reduce<UsageWindow | undefined>(
        (most, window) =>
          !most || window.usedPercent > most.usedPercent ? window : most,
        undefined,
      )
    : undefined;

export const remainingPercent = (window: UsageWindow) =>
  Math.min(100, Math.max(0, 100 - window.usedPercent));

export const allowanceLevel = (remaining: number): AllowanceLevel =>
  remaining >= 50 ? 'high' : remaining >= 20 ? 'medium' : 'low';

export const indicatorStateOf = (
  state: UsageState,
  window: UsageWindow | undefined,
  connected: boolean,
  now: number,
): IndicatorState => {
  if (!connected) return 'offline';
  if (!window) return state.loading && !state.data ? 'checking' : 'unavailable';
  return isStaleUsage(state.data, connected, now) ? 'stale' : 'current';
};
