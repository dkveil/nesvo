import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';
import {
  sessionHistoryLimits,
  sessionSchema,
  providerSchema,
  summarizeSessionUsage,
  toSessionWindow,
  turnUsageSchema,
  type SessionWindow,
  type CreateSessionInput,
  type ScheduledJobSessionOrigin,
  type Session,
  type SessionMcp,
  type Delegation,
} from '@nesvo/contracts';
import { saveCostTurn } from '../cost-store';

export type WorkflowSessionOrigin = {
  kind: 'workflow';
  runId: string;
  stepId?: string;
};

export type SessionOrigin =
  | { kind: 'operator' }
  | {
      kind: 'import';
      sessionId: string;
      providerSessionId: string;
      messages: Session['messages'];
    }
  | { kind: 'workflow-assistant' }
  | ScheduledJobSessionOrigin
  | WorkflowSessionOrigin;

type SessionLinks = Pick<
  Session,
  | 'scheduledJobId'
  | 'scheduledJobRunId'
  | 'workflowRunId'
  | 'workflowStepId'
  | 'delegationEnabled'
>;

const originLinks = (
  origin: SessionOrigin,
  input: CreateSessionInput,
): SessionLinks => {
  switch (origin.kind) {
    case 'operator':
      return {
        scheduledJobId: null,
        scheduledJobRunId: null,
        workflowRunId: null,
        workflowStepId: null,
        delegationEnabled: input.provider === 'Codex',
      };
    case 'import':
    case 'workflow-assistant':
      return {
        scheduledJobId: null,
        scheduledJobRunId: null,
        workflowRunId: null,
        workflowStepId: null,
        delegationEnabled: false,
      };
    case 'scheduled-job':
      return {
        scheduledJobId: origin.scheduledJobId,
        scheduledJobRunId: origin.runId,
        workflowRunId: null,
        workflowStepId: null,
        delegationEnabled: false,
      };
    case 'workflow':
      return {
        scheduledJobId: null,
        scheduledJobRunId: null,
        workflowRunId: origin.runId,
        workflowStepId: origin.stepId ?? null,
        delegationEnabled: false,
      };
  }
};

const SESSION_COLUMNS =
  'id, document, scheduled_job_id AS scheduledJobId, scheduled_job_run_id AS scheduledJobRunId';

const NOT_QUARANTINED =
  'NOT EXISTS (SELECT 1 FROM session_quarantine WHERE session_id = sessions.id)';

const decodeSession = (row: Record<string, SQLOutputValue>) => {
  let document: unknown;
  try {
    document = JSON.parse(String(row.document));
  } catch {
    return { error: 'Invalid JSON' };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    return { error: 'Expected a session object' };
  const parsed = sessionSchema.safeParse({
    pullRequest: null,
    ...document,
    scheduledJobId: row.scheduledJobId ?? null,
    scheduledJobRunId: row.scheduledJobRunId ?? null,
  });
  if (!parsed.success)
    return {
      error: parsed.error.issues
        .slice(0, 10)
        .map(issue => `${issue.path.join('.') || 'document'} (${issue.code})`)
        .join('; '),
    };
  if (parsed.data.id !== row.id)
    return { error: 'Session ID does not match its row' };
  return { session: parsed.data };
};

const MESSAGES_TYPE =
  "CASE WHEN json_valid(document) THEN json_type(document, '$.messages') END";

const usageEntriesSchema = z.array(
  z.tuple([z.enum(['operator', 'agent']), turnUsageSchema.nullable()]),
);

const parseJson = (value: SQLOutputValue | undefined): unknown => {
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
};

const decodeSummary = (
  row: Record<string, SQLOutputValue>,
): SessionWindow | undefined => {
  const document = parseJson(row.document);
  if (!document || typeof document !== 'object' || Array.isArray(document))
    return;
  const messages = Array.from(
    { length: sessionHistoryLimits.tail },
    (_, index) => row[`tail${index}`],
  )
    .filter(value => value != null)
    .map(parseJson);
  const parsed = sessionSchema.safeParse({
    pullRequest: null,
    ...document,
    messages,
    scheduledJobId: row.scheduledJobId ?? null,
    scheduledJobRunId: row.scheduledJobRunId ?? null,
  });
  const usage = usageEntriesSchema.safeParse(parseJson(row.usage));
  if (!parsed.success || !usage.success || parsed.data.id !== row.id) return;
  return {
    ...parsed.data,
    messageCount: Number(row.messageCount),
    usageTotals: summarizeSessionUsage(
      usage.data.map(([author, entry]) => ({ author, usage: entry })),
    ),
  };
};

type QuarantinedSession = { id: string; document: string; error: string };

export class SessionStore {
  constructor(private readonly database: DatabaseSync) {}

  list(): Session[] {
    const rows = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE ${NOT_QUARANTINED} ORDER BY updated_at DESC, id`,
      )
      .all();
    const sessions: Session[] = [];
    const invalid: QuarantinedSession[] = [];
    for (const row of rows) {
      const decoded = decodeSession(row);
      if (decoded.session) sessions.push(decoded.session);
      else
        invalid.push({
          id: String(row.id),
          document: String(row.document),
          error: decoded.error,
        });
    }
    this.quarantine(invalid);
    return sessions;
  }

  listSummaries(): SessionWindow[] {
    const tail = Array.from(
      { length: sessionHistoryLimits.tail },
      (_, index) =>
        `json_extract(document, '$.messages[#-${sessionHistoryLimits.tail - index}]') AS tail${index}`,
    ).join(', ');
    const rows = this.database
      .prepare(
        `SELECT id, json_remove(document, '$.messages') AS document, json_array_length(document, '$.messages') AS messageCount, ${tail}, (SELECT json_group_array(json_array(value ->> '$.author', value -> '$.usage')) FROM json_each(document, '$.messages')) AS usage, scheduled_job_id AS scheduledJobId, scheduled_job_run_id AS scheduledJobRunId FROM sessions WHERE ${NOT_QUARANTINED} AND ${MESSAGES_TYPE} = 'array' ORDER BY updated_at DESC, id`,
      )
      .all();
    const summaries: SessionWindow[] = [];
    const invalid: string[] = [];
    for (const row of rows) {
      const summary = decodeSummary(row);
      if (summary) summaries.push(summary);
      else invalid.push(String(row.id));
    }
    for (const id of invalid) {
      const session = this.get(id);
      if (session) summaries.push(toSessionWindow(session));
    }
    const ids = new Set(summaries.map(summary => summary.id));
    const malformed = this.database
      .prepare(
        `SELECT id FROM sessions WHERE ${NOT_QUARANTINED} AND ${MESSAGES_TYPE} IS NOT 'array'`,
      )
      .all()
      .map(row => String(row.id))
      .filter(id => !ids.has(id));
    for (const id of malformed) this.get(id);
    return summaries;
  }

  providerConversations(): {
    provider: Session['provider'];
    providerSessionId: string;
    adopted: boolean;
  }[] {
    return this.database
      .prepare(
        "SELECT json_extract(document, '$.provider') AS provider, json_extract(document, '$.providerSessionId') AS providerSessionId, json_extract(document, '$.messages[0].origin') = 'imported' AS adopted FROM sessions WHERE providerSessionId IS NOT NULL",
      )
      .all()
      .map(row => ({
        provider: providerSchema.parse(row.provider),
        providerSessionId: String(row.providerSessionId),
        adopted: row.adopted === 1,
      }));
  }

  get(id: string): Session | undefined {
    const row = this.database
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ? AND ${NOT_QUARANTINED}`,
      )
      .get(id);
    if (!row) return;
    const decoded = decodeSession(row);
    if (decoded.session) return decoded.session;
    this.quarantine([
      { id, document: String(row.document), error: decoded.error },
    ]);
  }

  quarantinedCount(): number {
    return Number(
      this.database
        .prepare('SELECT count(*) AS count FROM session_quarantine')
        .get()?.count,
    );
  }

  createdSessionId(requestId: string): string | undefined {
    const id = this.database
      .prepare('SELECT id FROM sessions WHERE create_request_id = ?')
      .get(requestId)?.id;
    return typeof id === 'string' ? id : undefined;
  }

  private quarantine(rows: QuarantinedSession[]): void {
    if (!rows.length) return;
    const at = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const record = this.database.prepare(
        'INSERT INTO session_quarantine (session_id, document, error_summary, quarantined_at) VALUES (?, ?, ?, ?)',
      );
      const clear = this.database.prepare(
        "UPDATE sessions SET document = 'null' WHERE id = ?",
      );
      const removeFromHistory = this.database.prepare(
        'DELETE FROM history_entries WHERE session_id = ?',
      );
      for (const row of rows) {
        record.run(row.id, row.document, row.error, at);
        clear.run(row.id);
        removeFromHistory.run(row.id);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    console.error(`Invalid session documents quarantined: ${rows.length}.`);
  }

  create(
    input: CreateSessionInput,
    directory: string,
    origin?: SessionOrigin,
    mcp?: SessionMcp,
    worktree?: { id: string; metadata: NonNullable<Session['worktree']> },
  ): Session {
    const session = this.newSession(input, directory, origin, mcp, worktree);
    const { requestId } = input;
    this.saveMany(
      [session],
      requestId
        ? () => {
            this.database
              .prepare('UPDATE sessions SET create_request_id = ? WHERE id = ?')
              .run(requestId, session.id);
          }
        : undefined,
    );
    return session;
  }

  fork(
    source: Session,
    forkOf: NonNullable<Session['forkOf']>,
    native: { sessionId: string; model: string } | null,
    directory = source.directory,
    worktree?: { id: string; metadata: NonNullable<Session['worktree']> },
  ): Session {
    const session = this.newSession(
      {
        title: `Fork of ${source.title}`,
        provider: source.provider,
        model: source.model,
        mode: source.mode,
        directory,
        effort: source.effort ?? undefined,
      },
      directory,
      undefined,
      undefined,
      worktree,
    );
    session.forkOf = forkOf;
    session.delegationEnabled = source.delegationEnabled;
    if (native) {
      session.providerSessionId = native.sessionId;
      session.providerInitialized = true;
      session.actualModel = native.model;
    } else {
      session.pendingClaudeFork = source.providerSessionId;
    }
    this.save(session);
    return session;
  }

  private newSession(
    input: CreateSessionInput,
    directory: string,
    origin: SessionOrigin = { kind: 'operator' },
    mcp: SessionMcp = { servers: [], hooks: false },
    worktree?: { id: string; metadata: NonNullable<Session['worktree']> },
  ): Session {
    const settings = { ...input };
    delete settings.requestId;
    delete settings.isolation;
    const now = new Date().toISOString();
    const session: Session = {
      ...settings,
      mcp,
      effort: input.effort ?? null,
      id:
        worktree?.id ??
        (origin.kind === 'import' ? origin.sessionId : randomUUID()),
      ...(worktree ? { worktree: worktree.metadata } : {}),
      role: 'standalone',
      providerSessionId:
        origin.kind === 'import'
          ? origin.providerSessionId
          : input.provider === 'Claude Code'
            ? randomUUID()
            : null,
      providerInitialized: origin.kind === 'import',
      pendingApprovals: [],
      actualModel: null,
      directory,
      status: 'ready',
      error: null,
      activity: null,
      activities: [],
      activitiesTruncated: false,
      activityTruncatedRunIds: [],
      runId: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      messages: origin.kind === 'import' ? origin.messages : [],
      forkOf: null,
      pendingClaudeFork: null,
      providerThreadStarts: [],
      queue: [],
      parentId: null,
      parentRunId: null,
      scope: null,
      delegations: [],
      workflow: null,
      pullRequest: null,
      groupId: input.groupId ?? null,
      order: 0,
      pinned: false,
      archivedAt: null,
      ...originLinks(origin, input),
    };
    return session;
  }

  save(session: Session): void {
    this.saveMany([session]);
  }

  saveMany(
    sessions: Session[],
    writeRelated?: () => void,
    { touch = true }: { touch?: boolean } = {},
  ): void {
    const now = new Date().toISOString();
    const next = sessions.map(session =>
      sessionSchema.parse({
        ...session,
        revision: session.revision + 1,
        updatedAt: touch ? now : session.updatedAt,
      }),
    );
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.database.prepare(
        'INSERT INTO sessions (id, document, updated_at, workflow_run_id, workflow_step_id, scheduled_job_id, scheduled_job_run_id) VALUES (?, ?, ?, (SELECT id FROM workflow_runs WHERE id = ?), (SELECT id FROM workflow_steps WHERE id = ?), (SELECT id FROM scheduled_jobs WHERE id = ?), (SELECT id FROM scheduled_job_runs WHERE id = ?)) ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at, workflow_run_id = excluded.workflow_run_id, workflow_step_id = excluded.workflow_step_id, scheduled_job_id = excluded.scheduled_job_id, scheduled_job_run_id = excluded.scheduled_job_run_id',
      );
      for (const session of next) {
        statement.run(
          session.id,
          JSON.stringify(session),
          session.updatedAt,
          session.workflowRunId,
          session.workflowStepId,
          session.scheduledJobId,
          session.scheduledJobRunId,
        );
        saveCostTurn(this.database, session);
      }
      writeRelated?.();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    sessions.forEach((session, index) => Object.assign(session, next[index]));
  }

  worker(parent: Session, proposal: Delegation, directory: string): Session {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      title: proposal.title,
      provider: proposal.provider,
      model: proposal.model,
      effort: null,
      mode: proposal.mode,
      role: 'worker',
      parentId: parent.id,
      parentRunId: proposal.runId,
      scope: proposal.scope,
      delegationEnabled: false,
      delegations: [],
      workflowRunId: null,
      workflowStepId: null,
      workflow: null,
      mcp: { servers: [], hooks: false },
      pullRequest: null,
      scheduledJobId: null,
      scheduledJobRunId: null,
      providerSessionId:
        proposal.provider === 'Claude Code' ? randomUUID() : null,
      providerInitialized: false,
      pendingApprovals: [],
      actualModel: null,
      directory,
      status: 'ready',
      error: null,
      activity: null,
      activities: [],
      activitiesTruncated: false,
      activityTruncatedRunIds: [],
      runId: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
      forkOf: null,
      pendingClaudeFork: null,
      providerThreadStarts: [],
      queue: [],
      groupId: null,
      order: 0,
      pinned: false,
      archivedAt: null,
    };
  }

  recover(writeRelated?: () => void): void {
    const sessions = this.list();
    const byId = new Map(sessions.map(session => [session.id, session]));
    const updates = new Map<string, Session>();
    const at = new Date().toISOString();
    for (const session of sessions) {
      let changed = false;
      if (session.status === 'running' || session.status === 'stopping') {
        session.status = 'interrupted';
        if (session.runId)
          session.interruption =
            session.interruption?.runId === session.runId
              ? session.interruption
              : { runId: session.runId, reason: 'host-restart', at };
        session.error =
          'The previous run ended before its outcome was confirmed. Inspect the workspace before continuing; no task was replayed.';
        session.activity = null;
        for (const message of session.messages) {
          if (message.state === 'running' || message.state === 'stopping') {
            message.state = 'interrupted';
            message.completedAt = at;
            message.interruption = {
              runId: message.runId,
              reason: session.interruption?.reason ?? 'host-restart',
              at,
            };
          }
        }
        changed = true;
      }
      if (session.pendingApprovals.length) {
        session.pendingApprovals = [];
        changed = true;
      }
      if (session.queue.some(item => !item.held)) {
        session.queue = session.queue.map(item => ({ ...item, held: true }));
        changed = true;
      }
      for (const activity of session.activities) {
        if (activity.status !== 'running') continue;
        activity.status = 'interrupted';
        activity.completedAt = at;
        changed = true;
      }
      if (changed) updates.set(session.id, session);
    }
    for (const session of sessions) {
      for (const proposal of session.delegations) {
        if (
          proposal.status === 'planning' ||
          proposal.status === 'plan-ready'
        ) {
          proposal.status = 'interrupted';
          proposal.error =
            'The previous host stopped before this worker plan was accepted. No worker was restarted.';
          updates.set(session.id, session);
          continue;
        }
        if (proposal.status !== 'pending' && proposal.status !== 'running')
          continue;
        const child = proposal.childSessionId
          ? byId.get(proposal.childSessionId)
          : undefined;
        const related =
          child?.parentId === session.id &&
          child.parentRunId === proposal.runId;
        if (related && !proposal.childRunId) {
          const task = child.messages.find(
            message => message.author === 'operator',
          );
          if (task?.body === proposal.task) proposal.childRunId = task.runId;
        }
        const result =
          related && proposal.childRunId
            ? child.messages.find(
                message =>
                  message.runId === proposal.childRunId &&
                  message.author === 'agent',
              )
            : undefined;
        if (
          result &&
          ['completed', 'stopped', 'failed', 'interrupted'].includes(
            result.state,
          )
        ) {
          proposal.status = result.state as
            'completed' | 'stopped' | 'failed' | 'interrupted';
          proposal.error = child?.runId === result.runId ? child.error : null;
        } else {
          proposal.status = 'interrupted';
          proposal.error =
            'The previous host could not confirm this delegation outcome. No worker was restarted.';
        }
        updates.set(session.id, session);
      }
    }
    if (updates.size || writeRelated)
      this.saveMany([...updates.values()], writeRelated);
  }
}
