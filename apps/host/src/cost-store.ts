import { randomUUID } from 'node:crypto';
import { basename, join, normalize } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  costBudgetSchema,
  type CostBudget,
  type CostBudgetList,
  type CostPeriod,
  type CostReport,
  type CostTotals,
  type CreateCostBudgetInput,
  type Provider,
  type ReadCostsInput,
  type Session,
} from '@nesvo/contracts';
import { codexAutoReview, CostPrices, resolveRates } from './cost-prices';
import { CostTranscripts } from './cost-transcripts';

export function migrateCosts(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cost_budgets (
      id TEXT PRIMARY KEY,
      document TEXT NOT NULL CHECK (json_valid(document))
    );
  `);
}

const dayMs = 86_400_000;

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    calendar: 'gregory',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function firstDay(period: CostPeriod, today: string) {
  const start = new Date(today + 'T00:00:00.000Z');
  if (period === 'week')
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (period === 'month') start.setUTCDate(1);
  return start.getTime();
}

function emptyTotals(): CostTotals {
  return {
    costUsd: null,
    estimatedCostTurns: 0,
    unknownCostTurns: 0,
    turnCount: 0,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    cacheSavingsUsd: null,
    partialCacheSavings: false,
  };
}

type RecordCost = {
  source: 'provider-reported' | 'estimated' | 'unpriced';
  costUsd: number | null;
  cacheSavingsUsd: number | null;
};

function price(
  row: UsageRow,
  rates: ReturnType<typeof resolveRates>,
): RecordCost {
  const { uncached, cache_read: cached, cache_write: written, output } = row;
  const savings =
    rates && (rates.read !== undefined || !cached)
      ? cached * Math.max(0, rates.input - (rates.read ?? rates.input))
      : null;
  if (row.reported !== null)
    return {
      source: 'provider-reported',
      costUsd: row.reported,
      cacheSavingsUsd: savings,
    };
  if (
    !rates ||
    (cached && rates.read === undefined) ||
    (written && rates.write === undefined)
  )
    return { source: 'unpriced', costUsd: null, cacheSavingsUsd: savings };
  return {
    source: 'estimated',
    costUsd:
      uncached * rates.input +
      cached * (rates.read ?? 0) +
      written * (rates.write ?? 0) +
      output * rates.output,
    cacheSavingsUsd: savings,
  };
}

function accumulate(totals: CostTotals, row: UsageRow, cost: RecordCost) {
  totals.turnCount++;
  totals.inputTokens =
    (totals.inputTokens ?? 0) + row.uncached + row.cache_read + row.cache_write;
  totals.cachedInputTokens = (totals.cachedInputTokens ?? 0) + row.cache_read;
  totals.outputTokens = (totals.outputTokens ?? 0) + row.output;
  if (cost.source === 'estimated') totals.estimatedCostTurns++;
  if (cost.source === 'unpriced') totals.unknownCostTurns++;
  if (cost.costUsd !== null)
    totals.costUsd = (totals.costUsd ?? 0) + cost.costUsd;
  if (cost.cacheSavingsUsd !== null)
    totals.cacheSavingsUsd =
      (totals.cacheSavingsUsd ?? 0) + cost.cacheSavingsUsd;
  else if (row.cache_read) totals.partialCacheSavings = true;
}

type UsageRow = {
  path: string;
  provider: Provider;
  started_at: string;
  directory: string | null;
  model: string | null;
  fast: number;
  uncached: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reported: number | null;
  session_id: string | null;
  session_title: string | null;
  group_id: string | null;
  group_name: string | null;
};

type RatedRow = { date: string; row: UsageRow; cost: RecordCost };
type Group = CostReport['groups'][number];
type TopSession = CostReport['topSessions'][number];

function grouping(
  row: UsageRow,
  by: ReadCostsInput['groupBy'],
): Pick<Group, 'key' | 'label'> {
  switch (by) {
    case 'provider':
      return { key: row.provider, label: row.provider };
    case 'model':
      return {
        key: JSON.stringify([row.provider, row.model]),
        label:
          row.provider === 'Codex' && row.model === codexAutoReview
            ? `${codexAutoReview} · no public price`
            : `${row.provider} · ${row.model ?? 'Model unavailable'}`,
      };
    case 'directory':
      return {
        key: row.directory ? folderKey(row.directory) : '',
        label: row.directory ?? 'Folder unavailable',
      };
    case 'session':
      return {
        key: row.session_id ?? '',
        label: row.session_title ?? 'Outside Nesvo',
      };
    case 'group':
      return { key: row.group_id ?? '', label: row.group_name ?? 'Ungrouped' };
  }
}

function bySpend(left: CostTotals, right: CostTotals) {
  return (
    (right.costUsd ?? -1) - (left.costUsd ?? -1) ||
    right.turnCount - left.turnCount
  );
}

function folderKey(path: string) {
  const folder = normalize(path);
  return process.platform === 'win32' ? folder.toLowerCase() : folder;
}

function atLimit(spend: number | null, limit: number): boolean {
  return (
    spend !== null &&
    spend > 0 &&
    (spend >= limit || limit - spend <= Number.EPSILON * limit)
  );
}

const budgetMoney = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const budgetSmallMoney = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  maximumSignificantDigits: 4,
});
const formatBudgetAmount = (amount: number) =>
  (amount > 0 && amount < 0.01 ? budgetSmallMoney : budgetMoney).format(amount);

function budgetLabel(
  budget: CostBudget,
  title: string,
  group: string | undefined,
) {
  if (budget.scope === 'session') return `Session budget “${title}”`;
  if (budget.scope === 'directory')
    return `Project folder budget “${basename(budget.target)}”`;
  if (budget.scope === 'group')
    return 'Session group budget “' + (group ?? 'Session group') + '”';
  return 'Computer budget';
}

function budgetDetails(totals: CostTotals) {
  return [
    totals.estimatedCostTurns ? 'estimated costs' : '',
    totals.unknownCostTurns ? 'unpriced usage' : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export class CostStore {
  private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private readonly budgetFormatter = dateFormatter(this.timeZone);
  private readonly transcripts: CostTranscripts;
  private readonly prices: CostPrices;
  private statuses: CostReport['transcripts'] = {
    'Claude Code': 'incomplete',
    Codex: 'incomplete',
  };
  private pending: Promise<void> | undefined;
  private readonly controller = new AbortController();

  constructor(
    private readonly database: DatabaseSync,
    directory: string,
    private readonly profiles: () => ReadonlyArray<{
      provider: Provider;
      configDirectory: string;
    }>,
  ) {
    this.transcripts = new CostTranscripts(database);
    this.prices = new CostPrices(join(directory, 'cost-prices.json'));
  }

  refresh(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    this.pending ??= Promise.all([
      this.transcripts.scan(this.profiles(), this.controller.signal).then(
        statuses => {
          this.statuses = statuses;
        },
        () => {
          this.statuses = { 'Claude Code': 'incomplete', Codex: 'incomplete' };
        },
      ),
      this.prices.refresh(this.controller.signal),
    ])
      .then(() => undefined)
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  async refreshBudgets() {
    if (this.database.prepare('SELECT 1 FROM cost_budgets LIMIT 1').get())
      await this.refresh();
  }

  async close() {
    this.controller.abort();
    await this.pending;
  }

  private *usage(
    period: CostPeriod,
    now: Date,
    formatter: Intl.DateTimeFormat,
  ): Iterable<RatedRow> {
    const first = firstDay(period, formatter.format(now));
    const firstDate = new Date(first).toISOString().slice(0, 10);
    const cache = new Map<string, ReturnType<typeof resolveRates>>();
    const records = this.database.prepare(`
      WITH ranked AS (
        SELECT usage.*, file.provider,
          row_number() OVER (
            PARTITION BY file.provider, usage.record_key
            ORDER BY usage.reported IS NULL, usage.output DESC, usage.model IS NULL, usage.started_at, usage.path
          ) AS rank
        FROM cost_transcript_usage AS usage
        JOIN cost_transcript_files AS file USING (path)
        WHERE usage.started_at >= ? AND usage.started_at <= ?
      ), mapped AS (
        SELECT id,
          document ->> '$.provider' AS provider,
          document ->> '$.providerSessionId' AS provider_session,
          document ->> '$.title' AS title,
          document ->> '$.groupId' AS group_id,
          row_number() OVER (
            PARTITION BY document ->> '$.provider', document ->> '$.providerSessionId'
            ORDER BY updated_at DESC, id
          ) AS rank
        FROM sessions
        WHERE document ->> '$.providerSessionId' IS NOT NULL AND
          id NOT IN (SELECT session_id FROM session_tombstones)
      )
      SELECT ranked.*, mapped.id AS session_id, mapped.title AS session_title,
        groups.id AS group_id, groups.name AS group_name
      FROM ranked
      LEFT JOIN mapped ON mapped.rank = 1 AND mapped.provider = ranked.provider
        AND mapped.provider_session = ranked.provider_session
      LEFT JOIN session_groups AS groups ON groups.id = mapped.group_id
      WHERE ranked.rank = 1
    `);
    let findModel: ReturnType<CostTranscripts['modelLookup']> | undefined;
    for (const entry of records.iterate(
      new Date(first - dayMs).toISOString(),
      now.toISOString(),
    )) {
      const row = entry as UsageRow;
      const date = formatter.format(new Date(row.started_at));
      if (date < firstDate) continue;
      if (row.provider === 'Codex' && row.model === null) {
        findModel ??= this.transcripts.modelLookup();
        row.model = findModel(row.path, row.started_at) ?? null;
      }
      const key = JSON.stringify([row.model, row.fast]);
      if (!cache.has(key))
        cache.set(
          key,
          row.model
            ? resolveRates(this.prices.table, row.model, !!row.fast)
            : undefined,
        );
      yield { row, date, cost: price(row, cache.get(key)) };
    }
  }

  read(input: ReadCostsInput, now = new Date()): CostReport {
    const formatter = dateFormatter(input.timeZone);
    const today = formatter.format(now);
    const dates = new Map<string, CostReport['buckets'][number]>();
    for (
      let day = firstDay(input.range, today);
      day <= Date.parse(today + 'T00:00:00.000Z');
      day += dayMs
    ) {
      const date = new Date(day).toISOString().slice(0, 10);
      dates.set(date, { date, ...emptyTotals() });
    }
    const groups = new Map<string, Group>();
    const sessions = new Map<string, TopSession>();
    const totals = emptyTotals();
    for (const { date, row, cost } of this.usage(input.range, now, formatter)) {
      accumulate(totals, row, cost);
      const bucket = dates.get(date);
      if (bucket) accumulate(bucket, row, cost);
      const group = grouping(row, input.groupBy);
      const item = groups.get(group.key) ?? { ...group, ...emptyTotals() };
      accumulate(item, row, cost);
      groups.set(group.key, item);
      if (!row.session_id) continue;
      const session = sessions.get(row.session_id) ?? {
        sessionId: row.session_id,
        title: row.session_title ?? '',
        ...emptyTotals(),
      };
      accumulate(session, row, cost);
      sessions.set(session.sessionId, session);
    }
    return {
      transcripts: this.statuses,
      totals,
      buckets: [...dates.values()],
      groups: [...groups.values()].sort(
        (a, b) => bySpend(a, b) || a.label.localeCompare(b.label),
      ),
      topSessions: [...sessions.values()].sort(bySpend).slice(0, 10),
    };
  }

  private budgets(): CostBudget[] {
    return this.database
      .prepare('SELECT document FROM cost_budgets ORDER BY rowid')
      .all()
      .map(row => costBudgetSchema.parse(JSON.parse(String(row.document))));
  }

  list(now = new Date()): CostBudgetList {
    return {
      timeZone: this.timeZone,
      budgets: this.spend(this.budgets(), now),
    };
  }

  create(input: CreateCostBudgetInput): CostBudget | null {
    const count = this.database
      .prepare('SELECT COUNT(*) AS count FROM cost_budgets')
      .get();
    if (Number(count?.count) >= 100) return null;
    const budget = { ...input, id: randomUUID() };
    this.database
      .prepare('INSERT INTO cost_budgets (id, document) VALUES (?, ?)')
      .run(budget.id, JSON.stringify(budget));
    return budget;
  }

  update(budget: CostBudget): boolean {
    return (
      this.database
        .prepare('UPDATE cost_budgets SET document = ? WHERE id = ?')
        .run(JSON.stringify(budget), budget.id).changes !== 0
    );
  }

  delete(id: string): boolean {
    return (
      this.database.prepare('DELETE FROM cost_budgets WHERE id = ?').run(id)
        .changes !== 0
    );
  }

  check(
    session: Pick<Session, 'id' | 'directory' | 'title' | 'groupId'>,
    now: Date,
  ) {
    const budgets = this.budgets().filter(
      budget =>
        budget.scope === 'computer' ||
        (budget.scope === 'directory' &&
          folderKey(budget.target) === folderKey(session.directory)) ||
        (budget.scope === 'session' && budget.target === session.id) ||
        (budget.scope === 'group' && budget.target === session.groupId),
    );
    const warnings: string[] = [];
    for (const { budget, totals } of this.spend(budgets, now)) {
      if (!atLimit(totals.costUsd, budget.limitUsd)) continue;
      const details = budgetDetails(totals);
      const group =
        budget.scope === 'group'
          ? this.database
              .prepare('SELECT name FROM session_groups WHERE id = ?')
              .get(budget.target)?.name
          : undefined;
      const rule = budgetLabel(
        budget,
        session.title,
        typeof group === 'string' ? group : undefined,
      );
      const spend = formatBudgetAmount(totals.costUsd!);
      const limit = formatBudgetAmount(budget.limitUsd);
      const amounts = `${spend} spent of ${limit} per ${budget.period}`;
      const label = `${rule} (${amounts}${details ? `, ${details}` : ''})`;
      if (budget.action === 'refuse-new-turns')
        return {
          refusal: `${rule} refused this turn. ${amounts}.${details ? ` Figures include ${details}.` : ''} Change the rule in Costs → Budgets.`,
        };
      warnings.push(label);
    }
    if (!warnings.length) return {};
    const shown = warnings.slice(0, 3).join(', ');
    const others =
      warnings.length > 3 ? ` and ${warnings.length - 3} more` : '';
    return { warning: `Budget limit reached for ${shown}${others}.` };
  }

  private spend(budgets: CostBudget[], now: Date): CostBudgetList['budgets'] {
    const views = budgets.map(budget => ({ budget, totals: emptyTotals() }));
    const periods = new Set(budgets.map(budget => budget.period));
    for (const period of periods) {
      const inPeriod = views.filter(view => view.budget.period === period);
      for (const { row, cost } of this.usage(
        period,
        now,
        this.budgetFormatter,
      )) {
        for (const { budget, totals } of inPeriod) {
          if (
            budget.scope === 'computer' ||
            (budget.scope === 'session' && row.session_id === budget.target) ||
            (budget.scope === 'group' && row.group_id === budget.target) ||
            (budget.scope === 'directory' &&
              row.directory !== null &&
              folderKey(row.directory) === folderKey(budget.target))
          )
            accumulate(totals, row, cost);
        }
      }
    }
    return views;
  }
}
