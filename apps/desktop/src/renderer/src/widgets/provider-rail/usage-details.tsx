import type { Provider } from '@/entities/session';
import {
  formatPercent,
  formatResetTime,
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
            const expired =
              window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
            return (
              <li
                key={window.id}
                data-usage-window={window.id}
                className="space-y-1"
              >
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate">{window.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatPercent(Math.max(0, 100 - window.usedPercent))} left
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${provider} ${window.label} used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, window.usedPercent)}
                  aria-valuetext={`${formatPercent(window.usedPercent)} used${outdated ? ', stale observation' : ''}`}
                  className={`h-1 overflow-hidden rounded-full bg-secondary ${outdated ? 'opacity-50' : ''}`}
                >
                  <div
                    className="h-full bg-foreground/70"
                    style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                  />
                </div>
                <p className="text-2xs text-muted-foreground tabular-nums">
                  {window.resetsAt ? (
                    <>
                      {expired ? 'Reported reset passed ' : 'Resets '}
                      <time dateTime={window.resetsAt}>
                        {formatResetTime(window.resetsAt)}
                      </time>
                    </>
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
        <p className="text-2xs text-muted-foreground">
          Checked{' '}
          <time dateTime={data.checkedAt}>
            {formatResetTime(data.checkedAt)}
          </time>
          {data.source ? ` · ${sourceLabels[data.source]}` : ''}
          {outdated
            ? ' · a passed reset does not confirm a refreshed allowance'
            : ''}
        </p>
      )}
    </section>
  );
}
