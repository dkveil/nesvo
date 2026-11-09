import { useEffect, useRef, useState } from 'react';
import type { ProviderUsage } from '@nesvo/contracts';
import { RefreshCw, UserRound } from 'lucide-react';
import { Popover } from 'radix-ui';
import { providers, type Provider } from '@/entities/session';
import { Button } from '@/shared/ui/button';

type UsageState = { data?: ProviderUsage; loading: boolean; error: boolean };
type Props = {
  hostId: string;
  computerName: string;
  connected: boolean;
  states: Record<Provider, UsageState>;
  onRefresh: () => void;
  compact?: boolean;
  orientation?: 'vertical' | 'horizontal';
};

const percent = (value: number) =>
  `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)}%`;
const date = (value: string) =>
  new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(new Date(value));
const sourceLabels = {
  'codex-app-server': 'Codex',
  'claude-control': 'Claude Code',
};

function stale(
  data: ProviderUsage | undefined,
  connected: boolean,
  now: number,
) {
  return (
    !!data &&
    (!connected ||
      now - Date.parse(data.checkedAt) > 300000 ||
      data.windows.some(
        window =>
          window.resetsAt !== null && Date.parse(window.resetsAt) <= now,
      ))
  );
}

function observedWindow(data?: ProviderUsage) {
  return data?.status === 'ready'
    ? data.windows.reduce<ProviderUsage['windows'][number] | undefined>(
        (most, window) =>
          !most || window.usedPercent > most.usedPercent ? window : most,
        undefined,
      )
    : undefined;
}

function UsageDetails({
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
  const outdated = stale(data, connected, now);
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
                    {percent(Math.max(0, 100 - window.usedPercent))} remaining
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={`${provider} ${window.label} used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, window.usedPercent)}
                  aria-valuetext={`${percent(window.usedPercent)} used${outdated ? ', stale observation' : ''}`}
                  className={`h-1 overflow-hidden rounded-full bg-secondary ${outdated ? 'opacity-50' : ''}`}
                >
                  <div
                    className="h-full bg-foreground/70"
                    style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                  />
                </div>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  {percent(window.usedPercent)} used
                </p>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  {window.resetsAt ? (
                    <>
                      {expired ? 'Reported reset passed: ' : 'Resets: '}
                      <time dateTime={window.resetsAt}>
                        {date(window.resetsAt)}
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
          Checked <time dateTime={data.checkedAt}>{date(data.checkedAt)}</time>
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

export function ProviderRail({
  hostId,
  computerName,
  connected,
  states,
  onRefresh,
  compact = false,
  orientation = 'vertical',
}: Props) {
  const [selected, setSelected] = useState<Provider | 'all'>('all');
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === 'visible') setNow(Date.now());
    };
    const timer = window.setInterval(update, 15000);
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
        side={
          compact ? 'bottom' : orientation === 'horizontal' ? 'top' : 'right'
        }
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
  const horizontal = orientation === 'horizontal';
  return (
    <aside
      aria-label="Provider limits"
      data-host-id={hostId}
      className={
        horizontal
          ? 'flex shrink-0 items-center gap-0.5'
          : 'hidden w-12 shrink-0 flex-col items-center border-r bg-[#050505] py-3 md:flex'
      }
    >
      {!horizontal && <div className="flex-1" />}
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div
            className={
              horizontal
                ? 'flex items-center gap-0.5'
                : 'flex flex-col items-center gap-2'
            }
          >
            {providers.map(provider => {
              const state = states[provider];
              const window = !state.error
                ? observedWindow(state.data)
                : undefined;
              const outdated = stale(state.data, connected, now);
              const remaining = window
                ? percent(Math.max(0, 100 - window.usedPercent))
                : '—';
              const label = `${provider} limits: ${window ? `${window.label}, ${remaining} remaining${outdated ? ', stale' : ''}` : state.loading ? 'checking' : 'unavailable'}${!connected ? ', offline' : ''}`;
              const short = provider === 'Claude Code' ? 'CL' : 'CX';
              return (
                <button
                  key={provider}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-haspopup="dialog"
                  aria-expanded={open && selected === provider}
                  data-provider-indicator={provider}
                  data-usage-stale={outdated}
                  className={
                    horizontal
                      ? 'flex h-7 min-w-9 flex-col items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring'
                      : 'flex w-10 flex-col items-center gap-1 rounded-md px-1 py-2 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring'
                  }
                  onClick={event => {
                    returnFocus.current = event.currentTarget;
                    setSelected(provider);
                    setOpen(true);
                  }}
                >
                  {horizontal ? (
                    <span
                      className={`flex items-baseline gap-1 text-[10px] leading-3 tabular-nums ${outdated ? 'opacity-50' : ''}`}
                    >
                      <span className="font-medium tracking-wide">{short}</span>
                      <span>{remaining}</span>
                    </span>
                  ) : (
                    <>
                      <span className="text-[10px] font-medium tracking-wide">
                        {short}
                      </span>
                      <span
                        className={`text-[10px] leading-4 tabular-nums ${outdated ? 'opacity-50' : ''}`}
                      >
                        {remaining}
                      </span>
                      {window && outdated && (
                        <span className="text-[9px] leading-3 text-muted-foreground">
                          Stale
                        </span>
                      )}
                    </>
                  )}
                  <span className="h-0.5 w-6 overflow-hidden rounded-full bg-secondary">
                    {window && (
                      <span
                        className={`block h-full bg-foreground/60 ${outdated ? 'opacity-40' : ''}`}
                        style={{
                          width: `${Math.min(100, Math.max(0, 100 - window.usedPercent))}%`,
                        }}
                      />
                    )}
                  </span>
                </button>
              );
            })}
            <Popover.Trigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Account and limits"
                title="Account and limits"
                className={
                  horizontal
                    ? 'size-7 text-muted-foreground'
                    : 'mt-1 text-muted-foreground'
                }
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
    </aside>
  );
}
