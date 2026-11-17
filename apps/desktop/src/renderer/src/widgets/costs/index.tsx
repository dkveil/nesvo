import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Wallet } from 'lucide-react';
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
import { cn } from '@/shared/lib/cn';
import { hostKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { Disclosure } from '@/shared/ui/disclosure';
import { EmptyState } from '@/shared/ui/empty-state';
import { IconButton } from '@/shared/ui/icon-button';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { Meter } from '@/shared/ui/progress';
import { SectionLabel } from '@/shared/ui/section-label';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { BudgetDialog } from './budget-dialog';
import { CostAmount } from './cost-amount';
import { formatSpend } from './format-spend';
import { CostChart } from './cost-chart';
import {
  actionLabels,
  countFormat,
  periodLabels,
  scopeLabels,
  unknownCost,
} from './labels';

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

function budgetTone(percent: number | null, action: CostBudget['action']) {
  if (percent === null) return 'neutral';
  if (percent >= 100)
    return action === 'refuse-new-turns' ? 'error' : 'warning';
  return percent >= 80 ? 'warning' : 'neutral';
}

function CostTable({
  label,
  rows,
}: {
  label: string;
  rows: Array<CostTotals & { key: string; label: string; open?: () => void }>;
}) {
  const heading = 'h-7 px-2 text-right text-2xs font-medium whitespace-nowrap';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className={cn(heading, 'pl-0 text-left')} scope="col">
              {label}
            </th>
            <th className={heading} scope="col">
              Reported cost
            </th>
            <th className={heading} scope="col">
              Turns
            </th>
            <th className={cn(heading, 'pr-0')} scope="col">
              Without cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border tabular-nums">
          {rows.map(row => (
            <tr key={row.key} className="h-9">
              <td className="max-w-0 pr-2 [overflow-wrap:anywhere]">
                {row.open ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="-ml-2 max-w-full"
                    onClick={row.open}
                  >
                    <span className="truncate">{row.label}</span>
                  </Button>
                ) : (
                  row.label
                )}
              </td>
              <td className="w-28 px-2 text-right">
                <CostAmount cost={row.reportedCostUsd} />
              </td>
              <td className="w-20 px-2 text-right text-muted-foreground">
                {countFormat.format(row.turnCount)}
              </td>
              <td className="w-28 pl-2 text-right text-muted-foreground">
                {countFormat.format(row.unknownCostTurns)}
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
    <section
      aria-label="Costs"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto max-w-3xl space-y-6 px-5 py-5 md:px-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            label="Cost period"
            size="md"
            value={range}
            options={periods}
            onChange={setRange}
          />
          {computers.length > 1 && (
            <Select value={hostId} onValueChange={setSelected}>
              <SelectTrigger aria-label="Computer">
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
          <InlineNotice tone="loading">
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
        <div>
          <SectionLabel
            as="h2"
            className="px-0"
            action={
              <IconButton
                label="Refresh costs"
                size={24}
                onClick={() => setRefresh(value => value + 1)}
              >
                <RefreshCw />
              </IconButton>
            }
          >
            Reported cost · {timeZone}
          </SectionLabel>
          {report && (
            <CostAmount
              cost={report.totals.reportedCostUsd}
              className="text-display font-semibold tracking-tight"
            />
          )}
        </div>
        {error ? (
          <InlineNotice tone="error">{error}</InlineNotice>
        ) : report ? (
          <>
            <p className="text-xs text-muted-foreground">
              {report.totals.turnCount
                ? `${countFormat.format(report.totals.turnCount)} ${report.totals.turnCount === 1 ? 'turn' : 'turns'} · ${unknownCost(report.totals.unknownCostTurns)}`
                : 'No turns in this period'}
            </p>
            {report.buckets.length > 0 && (
              <CostChart range={range} buckets={report.buckets} />
            )}
          </>
        ) : (
          <InlineNotice tone="loading">Loading costs and budgets…</InlineNotice>
        )}
      </section>
      {report && report.topSessions.length > 0 && (
        <section aria-label="Top sessions" className="space-y-1">
          <SectionLabel as="h2" className="px-0">
            Top sessions
          </SectionLabel>
          <CostTable
            label="Session"
            rows={report.topSessions.map(row => ({
              ...row,
              key: row.sessionId,
              label: row.title,
              open: () => onSession(hostKey(row.sessionId, hostId)),
            }))}
          />
          <Disclosure
            title="Cost breakdown"
            className="-mx-2 pt-2"
            contentClassName="space-y-2 px-2 pt-2 text-foreground"
          >
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
              <InlineNotice tone="loading">Loading breakdown…</InlineNotice>
            )}
          </Disclosure>
        </section>
      )}
      {budgets && (
        <section aria-label="Budgets" className="space-y-1 border-t pt-4">
          <SectionLabel
            as="h2"
            className="px-0"
            action={
              <Button
                size="xs"
                variant="outline"
                onClick={() => setModal({ removing: false })}
              >
                <Plus />
                New budget
              </Button>
            }
          >
            Budgets
          </SectionLabel>
          <p className="text-xs text-muted-foreground">
            Periods use {budgets.timeZone}. Spend excludes turns without
            reported cost.
          </p>
          {budgets.budgets.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Wallet}
              title="No budgets on this computer"
              description="A budget warns, or refuses new turns, once reported spend reaches its limit."
            />
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
                return (
                  <li key={budget.id} className="space-y-2 py-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-ui font-medium">{label}</p>
                        {target && (
                          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                            {target}
                          </p>
                        )}
                      </div>
                      <span className="pt-0.5 text-xs whitespace-nowrap">
                        <CostAmount cost={spend} />
                        <span className="text-muted-foreground">
                          {' / '}
                          <CostAmount cost={limit} />
                        </span>
                      </span>
                      <div className="-mr-2 flex shrink-0 items-center gap-0.5">
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Edit ${label}`}
                          onClick={() => setModal({ budget, removing: false })}
                        >
                          Edit
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Delete ${label}`}
                          onClick={() => setModal({ budget, removing: true })}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                    <Meter
                      label={label}
                      value={percent}
                      tone={budgetTone(percent, budget.action)}
                      aria-valuetext={`${formatSpend(spend)} / ${formatSpend(limit)}`}
                    />
                    <p className="text-xs text-muted-foreground">
                      {periodLabels[budget.period]} ·{' '}
                      {actionLabels[budget.action]}
                      {totals.unknownCostTurns > 0
                        ? ` · ${unknownCost(totals.unknownCostTurns)}`
                        : ''}
                    </p>
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
