import { Hint } from '@/shared/ui/tooltip';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import type { Provider } from '@/entities/session';
import { Meter } from '@/shared/ui/progress';
import {
  formatPercent,
  formatResetTime,
  resetCountdown,
  usageWindowLabel,
  isStaleUsage,
  type UsageState,
} from './usage-state';

const sourceLabels = {
  'codex-app-server': 'Codex',
  'claude-control': 'Claude Code',
};

const planLabels: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  prolite: 'Pro Lite',
  plus: 'Plus',
  max: 'Max',
  team: 'Team',
  edu: 'Edu',
  enterprise: 'Enterprise',
};

const formatPlan = (plan: string) =>
  planLabels[plan.trim().toLowerCase()] ?? plan;

export function UsageDetails({
  provider,
  state,
  connected,
  now,
}: {
  provider: Provider;
  state: UsageState;
  connected: boolean;
  now: number;
}) {
  const { data, loading, error } = state;
  const checked = data ? formatRelativeTime(data.checkedAt, now) : '';
  const outdated = isStaleUsage(data, connected, now);
  const usable = !!data && data.status === 'ready' && !error;
  const status = !connected
    ? 'Offline · last observation'
    : error
      ? 'Could not refresh'
      : !data
        ? loading
          ? 'Checking…'
          : 'Unavailable'
        : data.status === 'unauthenticated'
          ? 'Sign-in required'
          : data.status === 'error'
            ? 'Unavailable'
            : data.status === 'unavailable'
              ? 'Not reported'
              : outdated
                ? 'Stale · refresh to verify'
                : null;
  return (
    <section
      aria-label={`${provider} usage`}
      data-provider-usage={provider}
      data-usage-status={error ? 'error' : (data?.status ?? 'unavailable')}
      data-usage-stale={outdated}
      data-usage-source={data?.source ?? undefined}
      className="space-y-2 py-3 first:pt-0 last:pb-0"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold">
          {provider}
          {data?.account?.plan && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {formatPlan(data.account.plan)}
            </span>
          )}
        </h3>
        {status && (
          <span className="text-2xs text-muted-foreground">{status}</span>
        )}
      </header>
      {data?.account?.label && (
        <p
          className="truncate text-2xs text-muted-foreground"
          title={data.account.label}
        >
          {data.account.label}
        </p>
      )}
      {usable && data.windows.length > 0 ? (
        <ul className="space-y-1.5">
          {data.windows.map(window => {
            return (
              <li
                key={window.id}
                data-usage-window={window.id}
                className="space-y-1"
              >
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate">
                    {usageWindowLabel(window.label)}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatPercent(Math.max(0, 100 - window.usedPercent))} left
                  </span>
                </div>
                <Meter
                  label={`${provider} ${window.label} used`}
                  value={Math.min(100, window.usedPercent)}
                  stale={outdated}
                  aria-valuetext={`${formatPercent(window.usedPercent)} used${outdated ? ', stale observation' : ''}`}
                />
                <p className="text-2xs text-muted-foreground tabular-nums">
                  {window.resetsAt ? (
                    <Hint label={formatResetTime(window.resetsAt)}>
                      <time
                        tabIndex={0}
                        className="focus-ring rounded-control"
                        dateTime={window.resetsAt}
                      >
                        {resetCountdown(window.resetsAt, now)}
                      </time>
                    </Hint>
                  ) : (
                    'Reset time not reported'
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {loading && !data
            ? 'Fetching reported account limits…'
            : 'No current quota values are available.'}
        </p>
      )}
      {data?.ordinaryUsageAllowed === false && (
        <p className="text-2xs text-muted-foreground">
          The provider reports that ordinary usage is unavailable. Session
          controls remain available.
        </p>
      )}
      {data?.detail && (
        <p className="text-2xs text-muted-foreground [overflow-wrap:anywhere]">
          {data.detail}
        </p>
      )}
      {data && (
        <div className="space-y-1 text-2xs text-muted-foreground">
          <p className="flex flex-wrap gap-x-1.5">
            <Hint label={formatResetTime(data.checkedAt)}>
              <time
                tabIndex={0}
                className="focus-ring rounded-control"
                dateTime={data.checkedAt}
              >
                {checked === 'now'
                  ? 'Checked just now'
                  : 'Checked ' + checked + ' ago'}
              </time>
            </Hint>
            {data.source && (
              <span className="whitespace-nowrap">
                · {sourceLabels[data.source]}
              </span>
            )}
          </p>
          {outdated && <p>Refresh to verify the current allowance.</p>}
        </div>
      )}
    </section>
  );
}
