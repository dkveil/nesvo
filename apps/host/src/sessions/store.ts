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
        'INSERT INTO sessions (id, document, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at',
      );
      for (const session of next)
        statement.run(session.id, JSON.stringify(session), session.updatedAt);
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
      mode: proposal.mode,
      role: 'worker',
      parentId: parent.id,
      parentRunId: proposal.runId,
      scope: proposal.scope,
      delegationEnabled: false,
      delegations: [],
      providerSessionId:
        proposal.provider === 'Claude Code' ? randomUUID() : null,
      providerInitialized: false,
      pendingApprovals: [],
      actualModel: null,
      directory,
      status: 'ready',
      error: null,
      activity: null,
      runId: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  recover(): void {
    for (const session of this.list()) {
      let changed = false;
      if (session.status === 'running' || session.status === 'stopping') {
        session.status = 'interrupted';
        session.error =
          'The session was interrupted when the host closed. You can continue the conversation.';
        session.activity = null;
        session.pendingApprovals = [];
        for (const message of session.messages) {
          if (message.state === 'running') message.state = 'interrupted';
        }
        changed = true;
      }
      for (const proposal of session.delegations) {
        if (proposal.status !== 'pending' && proposal.status !== 'running')
          continue;
        proposal.status = 'interrupted';
        proposal.error = 'Delegation was interrupted when the host closed.';
        changed = true;
      }
      if (changed) this.save(session);
    }
  }
}
