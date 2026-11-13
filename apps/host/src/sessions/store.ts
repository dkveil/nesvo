import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  sessionSchema,
  type CreateSessionInput,
  type Session,
  type Delegation,
} from '@nesvo/contracts';

export class SessionStore {
  constructor(private readonly database: DatabaseSync) {}

  list(): Session[] {
    return this.database
      .prepare('SELECT document FROM sessions ORDER BY updated_at DESC, id')
      .all()
      .map(row => sessionSchema.parse(JSON.parse(String(row.document))));
  }

  get(id: string): Session | undefined {
    const row = this.database
      .prepare('SELECT document FROM sessions WHERE id = ?')
      .get(id);
    return row
      ? sessionSchema.parse(JSON.parse(String(row.document)))
      : undefined;
  }

  create(input: CreateSessionInput, directory: string): Session {
    const now = new Date().toISOString();
    const session: Session = {
      ...input,
      effort: input.effort ?? null,
      id: randomUUID(),
      role: 'standalone',
      providerSessionId: input.provider === 'Claude Code' ? randomUUID() : null,
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
      parentId: null,
      parentRunId: null,
      scope: null,
      delegationEnabled: input.provider === 'Codex',
      delegations: [],
      pipelineRunId: null,
      pipelineStepId: null,
    };
    this.save(session);
    return session;
  }

  save(session: Session): void {
    this.saveMany([session]);
  }

  saveMany(sessions: Session[], writeRelated?: () => void): void {
    const next = sessions.map(session =>
      sessionSchema.parse({
        ...session,
        revision: session.revision + 1,
        updatedAt: new Date().toISOString(),
      }),
    );
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const statement = this.database.prepare(
        'INSERT INTO sessions (id, document, updated_at, pipeline_run_id, pipeline_step_id) VALUES (?, ?, ?, (SELECT id FROM pipeline_runs WHERE id = ?), (SELECT id FROM pipeline_steps WHERE id = ?)) ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at, pipeline_run_id = excluded.pipeline_run_id, pipeline_step_id = excluded.pipeline_step_id',
      );
      for (const session of next)
        statement.run(
          session.id,
          JSON.stringify(session),
          session.updatedAt,
          session.pipelineRunId,
          session.pipelineStepId,
        );
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
      pipelineRunId: null,
      pipelineStepId: null,
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
