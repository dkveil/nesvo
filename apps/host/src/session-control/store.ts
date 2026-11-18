import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  coordinatorPolicySchema,
  defaultCoordinatorPolicy,
  sessionControlEventSchema,
  sessionControlLimits,
  sessionModeSchema,
  type CoordinatorPolicy,
  type SessionControlEvent,
  type SessionControlEventType,
  type SessionMode,
  type SessionState,
} from '@nesvo/contracts';

type Row = Record<string, SQLOutputValue>;

export type PlanStatus = 'planning' | 'plan-ready' | 'accepted' | 'declined';

export type ControlledChild = {
  sessionId: string;
  parentId: string;
  planStatus: PlanStatus | null;
  planRound: number;
  targetMode: SessionMode | null;
  plan: string | null;
};

export type StoredAction = { tool: string; result: string };

const EVENTS_KEPT_PER_PARENT = 1000;
const PLAN_STATUSES = ['planning', 'plan-ready', 'accepted', 'declined'];

export const installSessionControlTables = (database: DatabaseSync) => {
  database.exec(
    'CREATE TABLE IF NOT EXISTS session_control_policy (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL CHECK (json_valid(document)))',
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS session_control_actions (action_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL)',
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS session_control_children (session_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, plan_status TEXT, plan_round INTEGER NOT NULL DEFAULT 0, target_mode TEXT, plan TEXT)',
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS session_control_children_parent ON session_control_children (parent_id)',
  );
  database.exec(
    'CREATE TABLE IF NOT EXISTS session_control_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, parent_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, status TEXT, summary TEXT NOT NULL, at TEXT NOT NULL)',
  );
  database.exec(
    'CREATE INDEX IF NOT EXISTS session_control_events_parent ON session_control_events (parent_id, seq)',
  );
};

const toChild = (row: Row): ControlledChild => ({
  sessionId: String(row.session_id),
  parentId: String(row.parent_id),
  planStatus: PLAN_STATUSES.includes(String(row.plan_status))
    ? (row.plan_status as PlanStatus)
    : null,
  planRound: Number(row.plan_round ?? 0),
  targetMode: sessionModeSchema.safeParse(row.target_mode).data ?? null,
  plan: typeof row.plan === 'string' ? row.plan : null,
});

export class SessionControlStore {
  constructor(private readonly database: DatabaseSync) {}

  policy(): CoordinatorPolicy {
    const row = this.database
      .prepare('SELECT document FROM session_control_policy WHERE id = 1')
      .get();
    if (!row) return defaultCoordinatorPolicy;
    try {
      return (
        coordinatorPolicySchema.safeParse(JSON.parse(String(row.document)))
          .data ?? defaultCoordinatorPolicy
      );
    } catch {
      return defaultCoordinatorPolicy;
    }
  }

  savePolicy(policy: CoordinatorPolicy): CoordinatorPolicy {
    const valid = coordinatorPolicySchema.parse(policy);
    this.database
      .prepare(
        'INSERT INTO session_control_policy (id, document) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document',
      )
      .run(JSON.stringify(valid));
    return valid;
  }

  action(actionId: string): StoredAction | undefined {
    const row = this.database
      .prepare(
        'SELECT tool, result FROM session_control_actions WHERE action_id = ?',
      )
      .get(actionId);
    return row ? { tool: String(row.tool), result: String(row.result) } : undefined;
  }

  saveAction(
    actionId: string,
    sessionId: string,
    tool: string,
    result: string,
  ): void {
    this.database
      .prepare(
        'INSERT OR IGNORE INTO session_control_actions (action_id, session_id, tool, result, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(actionId, sessionId, tool, result, new Date().toISOString());
  }

  child(sessionId: string): ControlledChild | undefined {
    const row = this.database
      .prepare('SELECT * FROM session_control_children WHERE session_id = ?')
      .get(sessionId);
    return row ? toChild(row) : undefined;
  }

  children(parentId: string): ControlledChild[] {
    return this.database
      .prepare(
        'SELECT * FROM session_control_children WHERE parent_id = ? ORDER BY rowid',
      )
      .all(parentId)
      .map(toChild);
  }

  saveChild(child: ControlledChild): void {
    this.database
      .prepare(
        'INSERT INTO session_control_children (session_id, parent_id, plan_status, plan_round, target_mode, plan) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET parent_id = excluded.parent_id, plan_status = excluded.plan_status, plan_round = excluded.plan_round, target_mode = excluded.target_mode, plan = excluded.plan',
      )
      .run(
        child.sessionId,
        child.parentId,
        child.planStatus,
        child.planRound,
        child.targetMode,
        child.plan,
      );
  }

  appendEvent(event: {
    parentId: string;
    sessionId: string;
    runId: string | null;
    type: SessionControlEventType;
    status: SessionState | null;
    summary: string;
  }): void {
    this.database
      .prepare(
        'INSERT INTO session_control_events (parent_id, session_id, run_id, type, status, summary, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        event.parentId,
        event.sessionId,
        event.runId,
        event.type,
        event.status,
        event.summary.slice(0, 2000),
        new Date().toISOString(),
      );
    this.database
      .prepare(
        'DELETE FROM session_control_events WHERE parent_id = ? AND seq <= (SELECT seq FROM session_control_events WHERE parent_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)',
      )
      .run(event.parentId, event.parentId, EVENTS_KEPT_PER_PARENT);
  }

  events(
    parentId: string,
    cursor: number,
  ): { events: SessionControlEvent[]; more: boolean } {
    const rows = this.database
      .prepare(
        'SELECT seq, session_id, run_id, type, status, summary, at FROM session_control_events WHERE parent_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .all(parentId, cursor, sessionControlLimits.events + 1);
    const events = rows
      .slice(0, sessionControlLimits.events)
      .map(row =>
        sessionControlEventSchema.parse({
          seq: Number(row.seq),
          at: row.at,
          sessionId: row.session_id,
          runId: row.run_id ?? null,
          type: row.type,
          status: row.status ?? null,
          summary: row.summary,
        }),
      );
    return { events, more: rows.length > sessionControlLimits.events };
  }
}
