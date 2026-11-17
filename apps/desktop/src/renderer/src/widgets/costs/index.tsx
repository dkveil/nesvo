import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  Computer,
  CostBudget,
  CostBudgetList,
  CostPeriod,
  CostReport,
  CostTotals,
  DesktopApi,
  DesktopSession,
  ReadCostsInput,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { formatCost } from '@/shared/lib/format-cost';
import { hostKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/shared/ui/tooltip';
import { BudgetDialog } from './budget-dialog';
import { actionLabels, periodLabels, scopeLabels } from './labels';

type Props = {
  api: DesktopApi;
  computers: Computer[];
  sessions: DesktopSession[];
  initialHostId: string;
  onSession: (key: string) => void;
};

const periods = (Object.keys(periodLabels) as CostPeriod[]).map(value => ({
  value,
  label: periodLabels[value],
}));
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayLabel = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const number = new Intl.NumberFormat('en');

function unknownCost(count: number): string {
  return `${number.format(count)} ${count === 1 ? 'turn' : 'turns'} without reported cost`;
}

function CostChart({ buckets }: { buckets: CostReport['buckets'] }) {
  const max = Math.max(
    0,
    ...buckets.map(bucket => bucket.reportedCostUsd ?? 0),
  );
  return (
    <figure aria-label="Reported spend by date" className="space-y-2">
      <div className="flex h-24 items-end gap-1 border-b border-border px-1">
        {buckets.map(bucket => {
          const date = dayLabel.format(new Date(bucket.date));
          const cost = bucket.reportedCostUsd;
          const description = bucket.turnCount
            ? `${date} · ${formatCost(cost)} · ${unknownCost(bucket.unknownCostTurns)}`
            : `${date} · No turns`;
          return (
            <Tooltip key={bucket.date}>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  aria-label={description}
                  className="flex h-full min-w-0 flex-1 items-end rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {cost !== null ? (
                    <span
                      className="w-full rounded-t-sm bg-foreground/70"
                      style={{
                        height:
                          max > 0 ? `max(2px, ${(cost / max) * 100}%)` : '2px',
                      }}
                    />
                  ) : bucket.turnCount ? (
                    <span className="w-full border-t-2 border-dashed border-muted-foreground/70" />
                  ) : null}
                </div>
              </TooltipTrigger>
              <TooltipContent>{description}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <figcaption className="flex justify-between text-2xs text-muted-foreground">
        <span>{dayLabel.format(new Date(buckets[0]!.date))}</span>
        {buckets.length > 1 && (
          <span>{dayLabel.format(new Date(buckets.at(-1)!.date))}</span>
        )}
      </figcaption>
    </figure>
  );
}

function CostTable({
  label,
  rows,
}: {
  label: string;
  rows: Array<CostTotals & { key: string; label: string; open?: () => void }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-2 font-medium" scope="col">
              {label}
            </th>
            <th
              className="px-2 text-right font-medium whitespace-nowrap"
              scope="col"
            >
              Reported cost
            </th>
            <th className="px-2 text-right font-medium" scope="col">
              Turns
            </th>
            <th
              className="pl-2 text-right font-medium whitespace-nowrap"
              scope="col"
            >
              Without cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border tabular-nums">
          {rows.map(row => (
            <tr key={row.key}>
              <td className="py-2 pr-2 [overflow-wrap:anywhere]">
                {row.open ? (
                  <button
                    type="button"
                    className="rounded-sm text-left hover:underline focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={row.open}
                  >
                    {row.label}
                  </button>
                ) : (
                  row.label
                )}
              </td>
              <td className="px-2 text-right">
                {formatCost(row.reportedCostUsd)}
              </td>
              <td className="px-2 text-right text-muted-foreground">
                {number.format(row.turnCount)}
              </td>
              <td className="pl-2 text-right text-muted-foreground">
                {number.format(row.unknownCostTurns)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Modal = { budget?: CostBudget; removing: boolean };

export function CostsView({
  api,
  computers,
  sessions,
  initialHostId,
  onSession,
}: Props) {
  const [selected, setSelected] = useState(initialHostId);
  const [range, setRange] = useState<CostPeriod>('week');
  const computer =
    computers.find(item => item.id === selected) ??
    computers.find(item => item.id === 'local');
  const hostId = computer?.id ?? 'local';
  return (
    <TooltipProvider>
      <section
        aria-label="Costs"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl space-y-6 px-5 py-5 md:px-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SegmentedControl
              label="Cost period"
              value={range}
              options={periods}
              onChange={setRange}
            />
            {computers.length > 1 && (
              <Select value={hostId} onValueChange={setSelected}>
                <SelectTrigger size="sm" aria-label="Computer">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {computers.map(item => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                      {item.status === 'disconnected' || item.status === 'error'
                        ? ' · Offline'
                        : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {!computer ||
          computer.status === 'connecting' ||
          computer.status === 'syncing' ? (
            <InlineNotice>
              Connecting to {computer?.name ?? 'Local'}…
            </InlineNotice>
          ) : computer.status !== 'connected' ? (
            <InlineNotice>
              {computer.name} is offline. Connect it to view costs and budgets.
            </InlineNotice>
          ) : !computer.capabilities.includes('costs') ? (
            <InlineNotice>
              Update the Nesvo host on {computer.name}, then reconnect to view
              costs and budgets.
            </InlineNotice>
          ) : (
            <ComputerCosts
              key={hostId}
              api={api}
              hostId={hostId}
              range={range}
              sessions={sessions.filter(item => item.hostId === hostId)}
              onSession={onSession}
            />
          )}
        </div>
      </section>
    </TooltipProvider>
  );
}

function ComputerCosts({
  api,
  hostId,
  range,
  sessions,
  onSession,
}: Pick<Props, 'api' | 'sessions' | 'onSession'> & {
  hostId: string;
  range: CostPeriod;
}) {
  const [groupBy, setGroupBy] = useState<ReadCostsInput['groupBy']>('provider');
  const [refresh, setRefresh] = useState(0);
  const [modal, setModal] = useState<Modal | null>(null);
  const [result, setResult] = useState<{
    key: string;
    report?: CostReport;
    budgets?: CostBudgetList;
    error?: string;
  }>();
  const key = `${range}/${groupBy}`;
  useEffect(() => {
    let current = true;
    void Promise.all([
      api.readCosts({ range, timeZone, groupBy }, hostId),
      api.listCostBudgets(hostId),
    ]).then(
      ([report, budgets]) => {
        if (current) setResult({ key, report, budgets });
      },
      error => {
        if (current) setResult({ key, error: errorDetail(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [api, hostId, range, groupBy, key, refresh]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRefresh(value => value + 1), 100);
    };
    const unsubscribe = api.subscribe(event => {
      if (event.type !== 'session-changed' || event.session.hostId !== hostId)
        return;
      if (event.session.messages.at(-1)?.completedAt) reload();
    });
    window.addEventListener('focus', reload);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [api, hostId]);
  const report = result?.key.startsWith(range + '/')
    ? result.report
    : undefined;
  const budgets = result?.budgets;
  const error = result?.key === key ? result.error : undefined;
  const closeModal = () => setModal(null);

  return (
    <>
      <section aria-label="Reported cost" className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xs font-medium text-muted-foreground">
              Reported cost · {timeZone}
            </h2>
            {report && (
              <p className="pt-1 text-2xl font-semibold tracking-tight tabular-nums">
                {formatCost(report.totals.reportedCostUsd)}
              </p>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh costs"
                onClick={() => setRefresh(value => value + 1)}
              >
                <RefreshCw />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh costs and budgets</TooltipContent>
          </Tooltip>
        </div>
        {error ? (
          <InlineNotice tone="error">{error}</InlineNotice>
        ) : report ? (
          <>
            <p className="text-xs text-muted-foreground">
              {report.totals.turnCount
                ? `${number.format(report.totals.turnCount)} ${report.totals.turnCount === 1 ? 'turn' : 'turns'} · ${unknownCost(report.totals.unknownCostTurns)}`
                : 'No turns in this period'}
            </p>
            {report.buckets.length > 0 && (
              <CostChart buckets={report.buckets} />
            )}
          </>
        ) : (
          <InlineNotice>Loading costs and budgets…</InlineNotice>
        )}
      </section>
      {report && report.topSessions.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Top sessions</h2>
          <CostTable
            label="Session"
            rows={report.topSessions.map(row => ({
              ...row,
              key: row.sessionId,
              label: row.title,
              open: () => onSession(hostKey(row.sessionId, hostId)),
            }))}
          />
          <details className="space-y-2 pt-2">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Cost breakdown
            </summary>
            <SegmentedControl
              label="Group costs by"
              value={groupBy}
              options={[
                { value: 'provider', label: 'Provider' },
                { value: 'directory', label: 'Directory' },
              ]}
              onChange={setGroupBy}
            />
            {result?.key === key ? (
              <CostTable
                label={groupBy === 'directory' ? 'Directory' : 'Provider'}
                rows={report.groups.map(row => ({ ...row, label: row.key }))}
              />
            ) : (
              <InlineNotice>Loading breakdown…</InlineNotice>
            )}
          </details>
        </section>
      )}
      {budgets && (
        <section className="space-y-3 border-t pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-sm font-medium">Budgets</h2>
              <p className="text-xs text-muted-foreground">
                Periods use {budgets.timeZone}. Spend excludes turns without
                reported cost.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setModal({ removing: false })}
            >
              New budget
            </Button>
          </div>
          {budgets.budgets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No budgets on this computer.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {budgets.budgets.map(({ budget, totals }) => {
                const target =
                  budget.scope === 'session'
                    ? (sessions.find(session => session.id === budget.target)
                        ?.title ?? budget.target)
                    : budget.scope === 'directory'
                      ? budget.target
                      : null;
                const label = `${scopeLabels[budget.scope]} budget ${budget.id.slice(0, 8)}`;
                const spend = totals.reportedCostUsd;
                const limit = budget.limitUsd;
                const percent =
                  spend === null ? null : Math.min(100, (spend / limit) * 100);
                const spending = `${formatCost(spend)} / ${formatCost(limit)}`;
                return (
                  <li
                    key={budget.id}
                    className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3"
                  >
                    <div className="min-w-48 flex-1 space-y-1.5 text-xs">
                      <div className="flex flex-wrap justify-between gap-1">
                        <span className="font-medium">{label}</span>
                        <span className="tabular-nums">{spending}</span>
                      </div>
                      {target && (
                        <p className="break-all text-muted-foreground">
                          {target}
                        </p>
                      )}
                      <div
                        className="h-1 overflow-hidden rounded-full bg-muted"
                        aria-label={label}
                        role="progressbar"
                        aria-valuenow={percent ?? undefined}
                        aria-valuetext={spending}
                      >
                        {percent !== null && (
                          <div
                            className="h-full rounded-full bg-foreground/70"
                            style={{ width: `${percent}%` }}
                          />
                        )}
                      </div>
                      <p className="text-muted-foreground">
                        {periodLabels[budget.period]} ·{' '}
                        {actionLabels[budget.action]}
                        {totals.unknownCostTurns > 0
                          ? ` · ${unknownCost(totals.unknownCostTurns)}`
                          : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${label}`}
                        onClick={() => setModal({ budget, removing: false })}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete ${label}`}
                        onClick={() => setModal({ budget, removing: true })}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {modal && (
            <BudgetDialog
              budget={modal.budget}
              removing={modal.removing}
              timeZone={budgets.timeZone}
              sessions={sessions}
              onSave={async input => {
                if (modal.budget)
                  await api.updateCostBudget(
                    { ...input, id: modal.budget.id },
                    hostId,
                  );
                else await api.createCostBudget(input, hostId);
                setRefresh(value => value + 1);
              }}
              onRemove={async () => {
                if (modal.budget)
                  await api.deleteCostBudget({ id: modal.budget.id }, hostId);
                setRefresh(value => value + 1);
              }}
              onClose={closeModal}
            />
          )}
        </section>
      )}
    </>
  );
}
