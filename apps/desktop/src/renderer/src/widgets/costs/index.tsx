import { Badge } from '@/shared/ui/badge';
import { pathBasename } from '@/shared/lib/path-basename';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { useEffect, useRef, useState } from 'react';
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
  SessionGroup,
  SessionGroupList,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { cn } from '@/shared/lib/cn';
import { hostKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
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
  costCoverage,
} from './labels';

type Props = {
  api: DesktopApi;
  computers: Computer[];
  sessions: DesktopSession[];
  initialHostId: string;
  showBudgets: boolean;
  groupsByHost: Record<string, SessionGroupList>;
  onSession: (key: string) => void;
};

const periods = (Object.keys(periodLabels) as CostPeriod[]).map(value => ({
  value,
  label: periodLabels[value],
}));
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const groupingLabels = {
  provider: 'Provider',
  model: 'Model',
  directory: 'Project folder',
  group: 'Session group',
} as const;
const groupingOptions = (
  Object.keys(groupingLabels) as (keyof typeof groupingLabels)[]
).map(value => ({ value, label: groupingLabels[value] }));

function TokenCount({ count }: { count: number | null }) {
  return count === null ? 'Unavailable' : countFormat.format(count);
}

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
              Cost (USD)
            </th>
            <th className={heading} scope="col">
              Input
            </th>
            <th className={heading} scope="col">
              Cached
            </th>
            <th className={cn(heading, 'pr-0')} scope="col">
              Output
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
                ) : label === 'Project folder' ? (
                  <MiddleTruncatedText path value={row.label} />
                ) : (
                  row.label
                )}
              </td>
              <td className="w-48 py-1.5 px-2 text-right whitespace-nowrap">
                {row.costUsd === null && row.unknownCostTurns ? (
                  <span className="text-muted-foreground">Unpriced</span>
                ) : (
                  <CostAmount cost={row.costUsd} />
                )}
                <div className="text-2xs text-muted-foreground">
                  {row.costUsd !== null ? costCoverage(row) : null}
                </div>
              </td>
              <td className="w-20 px-2 text-right text-muted-foreground">
                <TokenCount count={row.inputTokens} />
              </td>
              <td className="w-20 px-2 text-right text-muted-foreground">
                <TokenCount count={row.cachedInputTokens} />
              </td>
              <td className="w-20 pl-2 text-right text-muted-foreground">
                <TokenCount count={row.outputTokens} />
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
  showBudgets,
  groupsByHost,
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
      <div className="mx-auto max-w-5xl space-y-6 px-5 py-5 md:px-7">
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
            computerName={computer.name}
            groupBudgets={computer.capabilities.includes('group-cost-budgets')}
            groups={groupsByHost[hostId]?.groups ?? []}
            showBudgets={showBudgets && hostId === initialHostId}
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
  computerName,
  groupBudgets,
  groups,
  showBudgets,
}: Pick<Props, 'api' | 'sessions' | 'onSession' | 'showBudgets'> & {
  hostId: string;
  computerName: string;
  groupBudgets: boolean;
  groups: SessionGroup[];
  range: CostPeriod;
}) {
  const [groupBy, setGroupBy] =
    useState<Exclude<ReadCostsInput['groupBy'], 'session'>>('model');
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
  const budgetSection = useRef<HTMLElement>(null);
  const budgetsReady = !!budgets;
  useEffect(() => {
    if (showBudgets && budgetsReady)
      budgetSection.current?.scrollIntoView({ block: 'start' });
  }, [showBudgets, budgetsReady]);
  const error = result?.key === key ? result.error : undefined;
  const closeModal = () => setModal(null);

  return (
    <>
      <section aria-label="Transcript costs" className="space-y-3">
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
            Cost (USD) · {timeZone}
          </SectionLabel>
          {report && report.totals.turnCount > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-3">
              <CostAmount
                cost={report.totals.costUsd}
                className="text-display font-semibold tracking-tight"
              />
              <span className="text-xs text-muted-foreground">
                {costCoverage(report.totals)}
              </span>
            </div>
          )}
        </div>
        {error ? (
          <InlineNotice tone="error">{error}</InlineNotice>
        ) : report ? (
          <>
            {report.totals.turnCount ? (
              <>
                <dl className="grid grid-cols-2 gap-3 border-y py-3 sm:grid-cols-4">
                  {[
                    { label: 'Input tokens', count: report.totals.inputTokens },
                    {
                      label: 'Cached input',
                      count: report.totals.cachedInputTokens,
                    },
                    {
                      label: 'Output tokens',
                      count: report.totals.outputTokens,
                    },
                  ].map(({ label, count }) => (
                    <div key={label}>
                      <dt className="text-2xs text-muted-foreground">
                        {label}
                      </dt>
                      <dd className="text-ui font-medium tabular-nums">
                        <TokenCount count={count} />
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt className="text-2xs text-muted-foreground">
                      Cache savings
                    </dt>
                    <dd className="text-ui font-medium">
                      <CostAmount cost={report.totals.cacheSavingsUsd} />
                      {report.totals.partialCacheSavings &&
                        report.totals.cacheSavingsUsd !== null && (
                          <span className="ml-1 text-2xs text-muted-foreground">
                            partial
                          </span>
                        )}
                    </dd>
                  </div>
                </dl>
                {range !== 'day' && (
                  <CostChart range={range} buckets={report.buckets} />
                )}
              </>
            ) : (
              <EmptyState
                icon={Wallet}
                size="sm"
                title="No usage in this period"
                description="Costs appear here after this computer records usage in a provider transcript."
              />
            )}
            {Object.entries(report.transcripts).map(([provider, status]) =>
              status === 'available' ||
              (status === 'missing' && !report.totals.turnCount) ? null : (
                <p key={provider} className="text-xs text-muted-foreground">
                  {status === 'missing'
                    ? `No transcripts from ${provider} on this computer.`
                    : `Some ${provider} transcripts could not be read. Totals may be incomplete.`}
                </p>
              ),
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
        </section>
      )}
      {report && report.totals.turnCount > 0 && (
        <section aria-label="Cost breakdown" className="space-y-2">
          <SectionLabel as="h2" className="px-0">
            Cost breakdown
          </SectionLabel>
          <SegmentedControl
            label="Group costs by"
            value={groupBy}
            options={groupingOptions}
            onChange={setGroupBy}
          />
          {result?.key === key ? (
            <CostTable label={groupingLabels[groupBy]} rows={report.groups} />
          ) : (
            <InlineNotice tone="loading">Loading breakdown…</InlineNotice>
          )}
        </section>
      )}
      {budgets && (
        <section
          ref={budgetSection}
          aria-label="Budgets"
          className="space-y-1 border-t pt-4"
        >
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
            Periods use {budgets.timeZone}. Limits use known transcript costs.
          </p>
          {budgets.budgets.length === 0 ? (
            <EmptyState
              size="sm"
              icon={Wallet}
              title="No budgets on this computer"
              description="A budget warns, or refuses new turns, once transcript costs reach its limit."
            />
          ) : (
            <ul className="divide-y divide-border">
              {budgets.budgets.map(({ budget, totals }) => {
                const target =
                  budget.scope === 'computer'
                    ? computerName
                    : budget.scope === 'directory'
                      ? pathBasename(budget.target)
                      : budget.scope === 'group'
                        ? (groups.find(group => group.id === budget.target)
                            ?.name ?? 'Unavailable group')
                        : (sessions.find(
                            session => session.id === budget.target,
                          )?.title ?? 'Unavailable session');
                const label =
                  scopeLabels[budget.scope] + ' budget for ' + target;
                const spend = totals.costUsd;
                const limit = budget.limitUsd;
                const percent =
                  spend === null ? null : Math.min(100, (spend / limit) * 100);
                return (
                  <li key={budget.id} className="space-y-2 py-3">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p
                            className="min-w-0 truncate text-ui font-medium"
                            title={
                              budget.scope === 'directory'
                                ? budget.target
                                : target
                            }
                          >
                            {target}
                          </p>
                          <Badge
                            appearance="outline"
                            tone={budgetTone(percent, budget.action)}
                          >
                            {actionLabels[budget.action]}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {scopeLabels[budget.scope]} ·{' '}
                          {periodLabels[budget.period]}
                        </p>
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
                    {costCoverage(totals) && (
                      <p className="text-xs text-muted-foreground">
                        {costCoverage(totals)}
                      </p>
                    )}
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
              groups={groups}
              computerName={computerName}
              groupBudgets={groupBudgets}
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
