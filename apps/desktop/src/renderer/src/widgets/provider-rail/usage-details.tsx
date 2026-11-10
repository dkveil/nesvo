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
      ? 'Could not refresh limits'
      : !data
        ? loading
          ? 'Checking limits…'
          : 'Limits unavailable'
        : data.status === 'unauthenticated'
          ? 'Sign-in required'
          : data.status === 'error'
            ? 'Limits unavailable'
            : data.status === 'unavailable'
              ? 'Not reported by this connection'
              : outdated
                ? 'Stale · refresh to verify'
                : 'Current observation';
  return (
    <section
      aria-label={`${provider} usage`}
      data-provider-usage={provider}
      data-usage-status={error ? 'error' : (data?.status ?? 'unavailable')}
      data-usage-stale={outdated}
      data-usage-source={data?.source ?? undefined}
      className="space-y-3 py-4 first:pt-1 last:pb-0"
    >
      <header className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium">{provider}</h3>
        <span className="text-[11px] text-muted-foreground">{status}</span>
      </header>
      {data?.account && (
        <div className="space-y-0.5 text-xs">
          <p className="break-all">
            {data.account.label || 'Account name not reported'}
          </p>
          {data.account.plan && (
            <p className="text-muted-foreground">{data.account.plan}</p>
          )}
        </div>
      )}
      {usable && data.windows.length > 0 ? (
        <div className="space-y-3">
          {data.windows.map(window => {
            const expired =
              window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
            return (
              <div
                key={window.id}
                data-usage-window={window.id}
                className="space-y-1.5"
              >
                <div className="flex justify-between gap-3 text-xs">
                  <span>{window.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {formatPercent(Math.max(0, 100 - window.usedPercent))}{' '}
                    remaining
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
                <p className="text-[11px] leading-5 text-muted-foreground">
                  {formatPercent(window.usedPercent)} used
                </p>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  {window.resetsAt ? (
                    <>
                      {expired ? 'Reported reset passed: ' : 'Resets: '}
                      <time dateTime={window.resetsAt}>
                        {formatResetTime(window.resetsAt)}
                      </time>
                    </>
                  ) : (
                    'Reset time not reported.'
                  )}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {loading && !data
            ? 'Fetching reported account limits…'
            : 'No current quota values are available.'}
        </p>
      )}
      {data?.ordinaryUsageAllowed === false && (
        <p className="text-xs leading-5 text-muted-foreground">
          The provider reports that ordinary usage is unavailable. Session
          controls remain available.
        </p>
      )}
      {data?.detail && (
        <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
          {data.detail}
        </p>
      )}
      {data && (
        <p className="text-[11px] leading-5 text-muted-foreground">
          Checked{' '}
          <time dateTime={data.checkedAt}>
            {formatResetTime(data.checkedAt)}
          </time>
          {data.source ? ` · Reported by ${sourceLabels[data.source]}` : ''}
        </p>
      )}
      {outdated && (
        <p className="text-[11px] leading-5 text-muted-foreground">
          Values reflect the last check. A passed reset does not confirm a
          refreshed allowance.
        </p>
      )}
    </section>
  );
}
