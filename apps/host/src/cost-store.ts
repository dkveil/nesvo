import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  costBudgetSchema,
  type CostBudget,
  type CostBudgetList,
  type CostPeriod,
  type CostReport,
  type CostTotals,
  type CreateCostBudgetInput,
  type ReadCostsInput,
  type Session,
} from '@nesvo/contracts';

export function migrateCosts(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cost_turns (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      provider TEXT NOT NULL,
      directory TEXT NOT NULL,
      cost_usd REAL,
      PRIMARY KEY (session_id, run_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS cost_turns_started ON cost_turns(started_at);
    CREATE TABLE IF NOT EXISTS cost_budgets (
      id TEXT PRIMARY KEY,
      document TEXT NOT NULL CHECK (json_valid(document))
    );
    INSERT OR IGNORE INTO cost_turns
      SELECT sessions.id, message.value ->> '$.runId',
        message.value ->> '$.createdAt', document ->> '$.provider',
        document ->> '$.directory',
        CASE WHEN message.value ->> '$.usage.source' = 'provider-report'
          THEN message.value ->> '$.usage.costUsd' END
      FROM sessions, json_each(document, '$.messages') AS message
      WHERE message.value ->> '$.author' = 'agent';
  `);
}

export function saveCostTurn(database: DatabaseSync, session: Session): void {
  const message = session.messages.at(-1);
  if (message?.author !== 'agent') return;
  const cost =
    message.usage?.source === 'provider-report' ? message.usage.costUsd : null;
  database
    .prepare(
      `
      INSERT INTO cost_turns (session_id, run_id, started_at, provider, directory, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, run_id) DO UPDATE SET cost_usd = excluded.cost_usd
      WHERE cost_turns.cost_usd IS NOT excluded.cost_usd
    `,
    )
    .run(
      session.id,
      message.runId,
      message.createdAt,
      session.provider,
      session.directory,
      cost,
    );
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

function periodBounds(
  period: CostPeriod,
  now: Date,
  formatter: Intl.DateTimeFormat,
) {
  const today = formatter.format(now);
  const start = new Date(`${today}T00:00:00.000Z`);
  if (period === 'week')
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (period === 'month') start.setUTCDate(1);
  return {
    start,
    end: Date.parse(`${today}T00:00:00.000Z`),
    today,
    lowerBound: new Date(start.getTime() - dayMs).toISOString(),
    firstDate: start.toISOString().slice(0, 10),
    now: now.toISOString(),
  };
}

const sumColumns = `
  SUM(cost_usd) AS cost, COUNT(*) AS turns, COUNT(*) - COUNT(cost_usd) AS unknown
`;

function totals(row?: Record<string, SQLOutputValue>): CostTotals {
  return {
    reportedCostUsd: typeof row?.cost === 'number' ? row.cost : null,
    turnCount: Number(row?.turns ?? 0),
    unknownCostTurns: Number(row?.unknown ?? 0),
  };
}

const groupColumns = {
  session: 'session_id',
  directory: 'directory',
  provider: 'provider',
} as const;

function atLimit(spend: number | null, limit: number): boolean {
  if (spend === null || spend === 0) return false;
  return spend >= limit || limit - spend <= Number.EPSILON * limit;
}

function budgetLabel(budget: CostBudget): string {
  return `${budget.scope} budget ${budget.id.slice(0, 8)} (USD ${budget.limitUsd} per ${budget.period})`;
}

export class CostStore {
  private readonly timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  private readonly budgetFormatter = dateFormatter(this.timeZone);
  private formatter = this.budgetFormatter;

  constructor(private readonly database: DatabaseSync) {
    database.function('cost_local_date', value =>
      this.formatter.format(new Date(String(value))),
    );
  }

  read(input: ReadCostsInput, now = new Date()): CostReport {
    this.formatter = dateFormatter(input.timeZone);
    const period = periodBounds(input.range, now, this.formatter);
    const source = `
      FROM cost_turns
      WHERE started_at >= ? AND started_at <= ? AND cost_local_date(started_at) BETWEEN ? AND ?
    `;
    const params = [
      period.lowerBound,
      period.now,
      period.firstDate,
      period.today,
    ];
    const read = (sql: string) => this.database.prepare(sql).all(...params);
    const rows = read(`
      SELECT cost_local_date(started_at) AS date, ${sumColumns}
      ${source} GROUP BY date
    `);
    const dates = new Map(rows.map(row => [row.date, totals(row)]));
    const buckets: CostReport['buckets'] = [];
    for (
      let instant = period.start.getTime();
      instant <= period.end;
      instant += dayMs
    ) {
      const date = new Date(instant).toISOString().slice(0, 10);
      buckets.push({ date, ...(dates.get(date) ?? totals()) });
    }
    const group = groupColumns[input.groupBy];
    const groups = read(`
      SELECT ${group} AS key, ${sumColumns}
      ${source} GROUP BY ${group} ORDER BY cost DESC, turns DESC, key
    `).map(row => ({ key: String(row.key), ...totals(row) }));
    const topSessions = read(`
      WITH ranked AS (
        SELECT session_id, ${sumColumns}
        ${source} GROUP BY session_id ORDER BY cost DESC, turns DESC, session_id LIMIT 10
      )
      SELECT ranked.*, sessions.document ->> '$.title' AS title
      FROM ranked JOIN sessions ON sessions.id = ranked.session_id
      ORDER BY cost DESC, turns DESC, session_id
    `).map(row => ({
      sessionId: String(row.session_id),
      title: String(row.title),
      ...totals(row),
    }));
    const [overall] = read(`SELECT ${sumColumns} ${source}`);
    return { totals: totals(overall), buckets, groups, topSessions };
  }

  private budgets(): CostBudget[] {
    return this.database
      .prepare('SELECT document FROM cost_budgets ORDER BY rowid')
      .all()
      .map(row => costBudgetSchema.parse(JSON.parse(String(row.document))));
  }

  list(now = new Date()): CostBudgetList {
    this.formatter = this.budgetFormatter;
    return {
      timeZone: this.timeZone,
      budgets: this.budgets().map(budget => ({
        budget,
        totals: this.spend(budget, now),
      })),
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

  check(session: Pick<Session, 'id' | 'directory'>, now: Date) {
    this.formatter = this.budgetFormatter;
    const warnings: string[] = [];
    for (const budget of this.budgets()) {
      if (budget.scope === 'directory' && budget.target !== session.directory)
        continue;
      if (budget.scope === 'session' && budget.target !== session.id) continue;
      if (!atLimit(this.spend(budget, now).reportedCostUsd, budget.limitUsd))
        continue;
      const label = budgetLabel(budget);
      if (budget.action === 'refuse-new-turns')
        return {
          refusal: `New turn refused. The ${label} has reached its limit.`,
        };
      warnings.push(label);
    }
    if (!warnings.length) return {};
    const shown = warnings.slice(0, 3).join(', ');
    const others =
      warnings.length > 3 ? ` and ${warnings.length - 3} more` : '';
    return { warning: `Budget limit reached for ${shown}${others}.` };
  }

  private spend(budget: CostBudget, now: Date): CostTotals {
    const period = periodBounds(budget.period, now, this.budgetFormatter);
    const scope =
      budget.scope === 'computer'
        ? ''
        : `AND ${groupColumns[budget.scope]} = ?`;
    return totals(
      this.database
        .prepare(
          `
      SELECT ${sumColumns}
      FROM cost_turns
      WHERE started_at >= ? AND started_at <= ? AND cost_local_date(started_at) BETWEEN ? AND ? ${scope}
    `,
        )
        .get(
          period.lowerBound,
          period.now,
          period.firstDate,
          period.today,
          ...('target' in budget ? [budget.target] : []),
        ),
    );
  }
}
