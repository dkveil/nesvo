import { randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  coordinatorPolicySchema,
  defaultCoordinatorPolicy,
  sessionControlEventSchema,
  sessionControlLimits,
  sessionSteerInputSchema,
  sessionSteerResultSchema,
  type SessionSteerInput,
  sessionModeSchema,
  type CoordinatorPolicy,
  type CoordinatorDeliveryReceipt,
  type CoordinatorWakeState,
  type SessionControlEvent,
  type SessionControlEventType,
  type SessionMode,
  type SessionState,
} from '@nesvo/contracts';
import { managedSessionLimits } from '../setup-profile-service';
import { SessionError } from '../sessions/session-error';

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

export type StoredAction = {
  tool: string;
  result: string;
  inputHash: string | null;
};

const EVENTS_KEPT_PER_PARENT = 1000;
const PENDING_LIMIT = 1000;
export type WakeReason = NonNullable<CoordinatorWakeState['reason']>;
export type WakeEvent = SessionControlEvent & { recovery: WakeReason | null };
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
  const columns = database
    .prepare('PRAGMA table_info(session_control_events)')
    .all()
    .map(column => String(column.name));
  if (!columns.includes('detail'))
    database.exec('ALTER TABLE session_control_events ADD COLUMN detail TEXT');
  if (!columns.includes('decision_id'))
    database.exec(
      'ALTER TABLE session_control_events ADD COLUMN decision_id TEXT',
    );
  const actions = database
    .prepare('PRAGMA table_info(session_control_actions)')
    .all();
  if (!actions.some(column => column.name === 'input_hash'))
    database.exec(
      'ALTER TABLE session_control_actions ADD COLUMN input_hash TEXT',
    );
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_steering (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, document TEXT NOT NULL,
      request_id TEXT UNIQUE, request TEXT
    );
    CREATE TABLE IF NOT EXISTS coordinator_wake_settings (
      scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL, revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordinator_wake_settings_actions (
      id TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordinator_wake_paused (
      parent_id TEXT PRIMARY KEY, reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordinator_wake_events (
      seq INTEGER PRIMARY KEY, event_key TEXT NOT NULL UNIQUE, parent_id TEXT NOT NULL,
      document TEXT, recovery TEXT, batch_id TEXT, handled INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS coordinator_wake_events_pending
      ON coordinator_wake_events (parent_id, seq) WHERE handled = 0;
    CREATE TABLE IF NOT EXISTS coordinator_wake_overflow (
      parent_id TEXT NOT NULL, child_id TEXT NOT NULL, omitted INTEGER NOT NULL,
      PRIMARY KEY (parent_id, child_id)
    );
    CREATE TABLE IF NOT EXISTS coordinator_event_seen (
      parent_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE IF NOT EXISTS coordinator_wake_batches (
      id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, epoch TEXT NOT NULL, event_ids TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE, prepared_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS coordinator_wake_batches_time
      ON coordinator_wake_batches (prepared_at, parent_id);
  `);
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

  historyIdentity() {
    const read = this.database.prepare(
      'SELECT value FROM metadata WHERE key = ?',
    );
    const hostId = String(read.get('instance_id')?.value);
    const key = 'coordinator_history_key';
    const previous = read.get(key);
    if (previous) return { hostId, secret: String(previous.value) };
    const secret = randomBytes(32).toString('hex');
    this.database
      .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
      .run(key, secret);
    return { hostId, secret };
  }

  steering(id: string) {
    return this.database
      .prepare(
        'SELECT fingerprint, document FROM session_steering WHERE id = ?',
      )
      .get(id);
  }

  steeringRequest(requestId: string) {
    const row = this.database
      .prepare(
        'SELECT document, request FROM session_steering WHERE request_id = ?',
      )
      .get(requestId);
    if (!row) return null;
    const receipt = sessionSteerResultSchema.parse(
      JSON.parse(String(row.document)),
    );
    const { input, task } = JSON.parse(String(row.request)) as {
      input: unknown;
      task: string;
    };
    return {
      input: sessionSteerInputSchema.parse(input),
      task,
      messageId: receipt.messageId,
    };
  }

  saveSteering(
    id: string,
    fingerprint: string,
    document: unknown,
    request?: { input: SessionSteerInput; task: string },
  ) {
    const requestId = request ? sessionSteerResultSchema.parse(document) : null;
    this.database
      .prepare(
        `
      INSERT INTO session_steering (id, fingerprint, document, request_id, request)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document
    `,
      )
      .run(
        id,
        fingerprint,
        JSON.stringify(document),
        requestId?.status === 'awaiting-owner' ? requestId.requestId : null,
        request ? JSON.stringify(request) : null,
      );
  }

  policy(): CoordinatorPolicy {
    const policy = this.manualPolicy();
    const limits = managedSessionLimits(this.database);
    return {
      ...policy,
      groupSize: Math.min(policy.groupSize, limits.maxSessions ?? policy.groupSize),
      nested: policy.nested && limits.maxDepth !== 1,
      childModes: limits.workers === 'read-only'
        ? policy.childModes.filter(mode => mode === 'read-only')
        : policy.childModes,
    };
  }

  private manualPolicy(): CoordinatorPolicy {
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
    const limits = managedSessionLimits(this.database);
    const current = this.policy();
    const manual = this.manualPolicy();
    if (
      (limits.maxSessions !== undefined && valid.groupSize !== current.groupSize) ||
      (limits.maxDepth !== undefined && valid.nested !== current.nested) ||
      (limits.workers === 'read-only' &&
        JSON.stringify(valid.childModes) !== JSON.stringify(current.childModes))
    )
      throw new SessionError(
        'invalid-request',
        'This coordinator setting is managed by the profile. Edit it in Your setup.',
      );
    if (limits.maxSessions !== undefined) valid.groupSize = manual.groupSize;
    if (limits.maxDepth !== undefined) valid.nested = manual.nested;
    if (limits.workers === 'read-only') valid.childModes = manual.childModes;
    this.database
      .prepare(
        'INSERT INTO session_control_policy (id, document) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document',
      )
      .run(JSON.stringify(valid));
    return this.policy();
  }

  action(actionId: string): StoredAction | undefined {
    const row = this.database
      .prepare(
        'SELECT tool, result, input_hash FROM session_control_actions WHERE action_id = ?',
      )
      .get(actionId);
    return row
      ? {
          tool: String(row.tool),
          result: String(row.result),
          inputHash: typeof row.input_hash === 'string' ? row.input_hash : null,
        }
      : undefined;
  }

  saveAction(
    actionId: string,
    sessionId: string,
    tool: string,
    result: string,
    inputHash: string,
  ): void {
    this.database
      .prepare(
        'INSERT OR IGNORE INTO session_control_actions (action_id, session_id, tool, result, created_at, input_hash) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        actionId,
        sessionId,
        tool,
        result,
        new Date().toISOString(),
        inputHash,
      );
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

  appendEvent(
    event: {
      parentId: string;
      sessionId: string;
      runId: string | null;
      type: SessionControlEventType;
      status: SessionState | null;
      summary: string;
      detail?: string | null;
      decisionRecordId?: string;
    },
    wake?: { key: string; enabled: boolean; now: number },
  ): number | null {
    if (
      wake &&
      this.database
        .prepare('SELECT 1 FROM coordinator_wake_events WHERE event_key = ?')
        .get(wake.key)
    )
      return null;
    const at = new Date(wake?.now ?? Date.now()).toISOString();
    const result = this.database
      .prepare(
        'INSERT INTO session_control_events (parent_id, session_id, run_id, type, status, summary, detail, at, decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        event.parentId,
        event.sessionId,
        event.runId,
        event.type,
        event.status,
        event.summary.slice(0, 2000),
        event.detail?.slice(0, 2000) ?? null,
        at,
        event.decisionRecordId ?? null,
      );
    const seq = Number(result.lastInsertRowid);
    if (wake) this.captureWake(seq, event, wake, at);
    this.database
      .prepare(
        'DELETE FROM session_control_events WHERE parent_id = ? AND seq <= (SELECT seq FROM session_control_events WHERE parent_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)',
      )
      .run(event.parentId, event.parentId, EVENTS_KEPT_PER_PARENT);
    return seq;
  }

  private captureWake(
    seq: number,
    event: Parameters<SessionControlStore['appendEvent']>[0],
    wake: { key: string; enabled: boolean },
    at: string,
  ) {
    const overflow =
      wake.enabled && this.pendingCount(event.parentId) >= PENDING_LIMIT;
    const document =
      wake.enabled && !overflow
        ? JSON.stringify({
            seq,
            at,
            sessionId: event.sessionId,
            runId: event.runId,
            type: event.type,
            status: event.status,
            summary: event.summary.slice(0, 2000),
            detail: null,
            decisionRecordId: event.decisionRecordId,
          })
        : null;
    this.database
      .prepare(
        'INSERT INTO coordinator_wake_events (seq, event_key, parent_id, document, handled, recovery) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        seq,
        wake.key,
        event.parentId,
        document,
        document ? 0 : 1,
        this.paused(event.parentId),
      );
    if (overflow) {
      this.pause(event.parentId, 'overflow');
      this.database
        .prepare(
          `
        INSERT INTO coordinator_wake_overflow (parent_id, child_id, omitted) VALUES (?, ?, 1)
        ON CONFLICT(parent_id, child_id) DO UPDATE SET omitted = omitted + 1
      `,
        )
        .run(event.parentId, event.sessionId);
    }
  }

  transaction<T>(effect: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = effect();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  wakeSetting(sessionId: string | null, defaultEnabled: boolean) {
    const row = this.database
      .prepare(
        'SELECT enabled, revision FROM coordinator_wake_settings WHERE scope = ?',
      )
      .get(sessionId ?? 'computer');
    return {
      enabled: row ? row.enabled === 1 : defaultEnabled,
      revision: Number(row?.revision ?? 0),
    };
  }

  saveWakeSetting(
    sessionId: string | null,
    enabled: boolean,
    revision: number,
  ) {
    this.database
      .prepare(
        `
      INSERT INTO coordinator_wake_settings (scope, enabled, revision) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision
    `,
      )
      .run(sessionId ?? 'computer', Number(enabled), revision);
  }

  settingReceipt(id: string) {
    return this.database
      .prepare(
        'SELECT input, state FROM coordinator_wake_settings_actions WHERE id = ?',
      )
      .get(id);
  }

  saveSettingReceipt(id: string, input: string, state: CoordinatorWakeState) {
    this.database
      .prepare('INSERT INTO coordinator_wake_settings_actions VALUES (?, ?, ?)')
      .run(id, input, JSON.stringify(state));
  }

  pause(parentId: string | null, reason: WakeReason) {
    this.database
      .prepare(
        `
      UPDATE coordinator_wake_events SET recovery = ?
      WHERE handled = 0 AND batch_id IS NULL AND (? IS NULL OR parent_id = ?)
    `,
      )
      .run(reason, parentId, parentId);
  }

  pauseFuture(parentId: string, reason: WakeReason) {
    this.database
      .prepare('INSERT OR REPLACE INTO coordinator_wake_paused VALUES (?, ?)')
      .run(parentId, reason);
    this.pause(parentId, reason);
  }

  paused(parentId: string): WakeReason | null {
    const row = this.database
      .prepare('SELECT reason FROM coordinator_wake_paused WHERE parent_id = ?')
      .get(parentId);
    return row ? (row.reason as WakeReason) : null;
  }

  resume(parentId: string) {
    this.database
      .prepare('DELETE FROM coordinator_wake_paused WHERE parent_id = ?')
      .run(parentId);
  }

  pendingCount(parentId: string): number {
    return Number(
      this.database
        .prepare(
          'SELECT COUNT(*) AS total FROM coordinator_wake_events WHERE parent_id = ? AND handled = 0',
        )
        .get(parentId)?.total ?? 0,
    );
  }

  pendingParents(): string[] {
    return this.database
      .prepare(
        'SELECT parent_id FROM coordinator_wake_events WHERE handled = 0 GROUP BY parent_id ORDER BY MIN(seq)',
      )
      .all()
      .map(row => String(row.parent_id));
  }

  pending(parentId: string): WakeEvent[] {
    return this.database
      .prepare(
        'SELECT document, recovery FROM coordinator_wake_events WHERE parent_id = ? AND handled = 0 ORDER BY (recovery IS NULL), seq',
      )
      .all(parentId)
      .map(row => ({
        ...sessionControlEventSchema.parse(JSON.parse(String(row.document))),
        recovery: row.recovery as WakeReason | null,
      }));
  }

  overflow(parentId: string) {
    return this.database
      .prepare(
        'SELECT child_id, omitted FROM coordinator_wake_overflow WHERE parent_id = ? ORDER BY child_id',
      )
      .all(parentId)
      .map(row => ({
        sessionId: String(row.child_id),
        count: Number(row.omitted),
      }));
  }

  touchSeen(parentId: string, runId: string, ids: readonly number[]) {
    const seen = this.database.prepare(
      'INSERT OR IGNORE INTO coordinator_event_seen (parent_id, run_id, seq) VALUES (?, ?, ?)',
    );
    for (const id of ids) seen.run(parentId, runId, id);
  }

  clearSeen(runId: string) {
    this.database
      .prepare('DELETE FROM coordinator_event_seen WHERE run_id = ?')
      .run(runId);
  }

  acknowledge(parentId: string, runId: string, ids: readonly number[]) {
    const read = this.database.prepare(
      'SELECT acknowledged FROM coordinator_event_seen WHERE parent_id = ? AND run_id = ? AND seq = ?',
    );
    const rows = ids.map(id => read.get(parentId, runId, id));
    if (rows.some(row => !row)) return null;
    const acknowledged: number[] = [];
    const alreadyHandled: number[] = [];
    const update = this.database.prepare(
      'UPDATE coordinator_event_seen SET acknowledged = 1 WHERE run_id = ? AND seq = ?',
    );
    const handled = this.database.prepare(
      'UPDATE coordinator_wake_events SET handled = 1 WHERE parent_id = ? AND seq = ? AND handled = 0',
    );
    for (const [index, id] of ids.entries()) {
      if (rows[index]?.acknowledged || !handled.run(parentId, id).changes)
        alreadyHandled.push(id);
      else acknowledged.push(id);
      update.run(runId, id);
    }
    return { acknowledged, alreadyHandled };
  }

  acknowledgeWorkerResult(parentId: string, childId: string, runId: string) {
    this.database
      .prepare(
        `
      UPDATE coordinator_wake_events SET handled = 1
      WHERE parent_id = ? AND handled = 0 AND batch_id IS NULL
        AND json_extract(document, '$.sessionId') = ?
        AND json_extract(document, '$.runId') = ?
        AND json_extract(document, '$.type') IN ('finished', 'failed')
    `,
      )
      .run(parentId, childId, runId);
  }

  suppress(parentId: string, seq: number) {
    this.database
      .prepare(
        'UPDATE coordinator_wake_events SET handled = 1 WHERE parent_id = ? AND seq = ? AND batch_id IS NULL',
      )
      .run(parentId, seq);
  }

  batch(id: string, parentId: string): CoordinatorDeliveryReceipt | null {
    const row = this.database
      .prepare(
        'SELECT message_id, run_id FROM coordinator_wake_batches WHERE id = ? AND parent_id = ?',
      )
      .get(id, parentId);
    return row
      ? {
          batchId: id,
          messageId: String(row.message_id),
          runId: String(row.run_id),
        }
      : null;
  }

  preparedRun(parentId: string, runId: string): string | null {
    const row = this.database
      .prepare(
        'SELECT id FROM coordinator_wake_batches WHERE parent_id = ? AND run_id = ?',
      )
      .get(parentId, runId);
    return row ? String(row.id) : null;
  }

  batchEvents(batchId: string): WakeEvent[] {
    return this.database
      .prepare(
        'SELECT document FROM coordinator_wake_events WHERE batch_id = ? ORDER BY seq',
      )
      .all(batchId)
      .map(row => ({
        ...sessionControlEventSchema.parse(JSON.parse(String(row.document))),
        recovery: null,
      }));
  }

  wakeRunsAfter(parentId: string | null, start: number): number[] {
    return this.database
      .prepare(
        'SELECT prepared_at FROM coordinator_wake_batches WHERE prepared_at > ? AND (? IS NULL OR parent_id = ?) ORDER BY prepared_at',
      )
      .all(start, parentId, parentId)
      .map(row => Number(row.prepared_at));
  }

  prepareBatch(
    parentId: string,
    receipt: CoordinatorDeliveryReceipt,
    epoch: string,
    now: number,
    ids: number[],
    clearOverflow: boolean,
  ) {
    this.database
      .prepare(
        'INSERT INTO coordinator_wake_batches VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        receipt.batchId,
        parentId,
        epoch,
        JSON.stringify(ids),
        receipt.messageId,
        receipt.runId,
        now,
      );
    const bind = this.database.prepare(
      'UPDATE coordinator_wake_events SET batch_id = ?, handled = 1 WHERE seq = ? AND parent_id = ? AND handled = 0 AND batch_id IS NULL',
    );
    for (const id of ids)
      if (!bind.run(receipt.batchId, id, parentId).changes)
        throw Error('Wake event is no longer pending');
    if (clearOverflow)
      this.database
        .prepare('DELETE FROM coordinator_wake_overflow WHERE parent_id = ?')
        .run(parentId);
  }

  events(
    parentId: string,
    cursor: number,
  ): { events: SessionControlEvent[]; more: boolean } {
    const rows = this.database
      .prepare(
        'SELECT seq, session_id, run_id, type, status, summary, detail, at, decision_id FROM session_control_events WHERE parent_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      )
      .all(parentId, cursor, sessionControlLimits.events + 1);
    const events = rows.slice(0, sessionControlLimits.events).map(row =>
      sessionControlEventSchema.parse({
        seq: Number(row.seq),
        at: row.at,
        sessionId: row.session_id,
        runId: row.run_id ?? null,
        type: row.type,
        status: row.status ?? null,
        summary: row.summary,
        detail: row.detail ?? null,
        ...(row.decision_id ? { decisionRecordId: row.decision_id } : {}),
      }),
    );
    return { events, more: rows.length > sessionControlLimits.events };
  }
}
