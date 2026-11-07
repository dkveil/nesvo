import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  sessionSchema,
  type CreateSessionInput,
  type Session,
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
      provider: 'Claude Code',
      providerSessionId: randomUUID(),
      providerInitialized: false,
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
    this.save(session);
    return session;
  }

  save(session: Session): void {
    const next = sessionSchema.parse({
      ...session,
      revision: session.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    this.database
      .prepare(
        'INSERT INTO sessions (id, document, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at',
      )
      .run(next.id, JSON.stringify(next), next.updatedAt);
    Object.assign(session, next);
  }

  recover(): void {
    for (const session of this.list()) {
      if (session.status !== 'running' && session.status !== 'stopping')
        continue;
      session.status = 'interrupted';
      session.error =
        'Sesja została przerwana przez zamknięcie hosta. Możesz kontynuować rozmowę.';
      session.activity = null;
      for (const message of session.messages) {
        if (message.state === 'running') message.state = 'interrupted';
      }
      this.save(session);
    }
  }
}
