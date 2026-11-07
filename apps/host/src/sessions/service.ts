import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  CreateSessionInput,
  DesktopEvent,
  SendMessageInput,
  Session,
  StopRunInput,
  RespondApprovalInput,
} from '@nesvo/contracts';
import { startClaude, type ClaudeEvent } from '../providers/claude';
import { startCodex, type CodexEvent } from '../providers/codex';
import { SessionStore } from './store';

export class SessionError extends Error {
  constructor(
    readonly code:
      'busy' | 'not-found' | 'invalid-directory' | 'invalid-request',
    message: string,
  ) {
    super(message);
  }
}

type ActiveRun = {
  session: Session;
  handle: ReturnType<typeof startClaude> | ReturnType<typeof startCodex>;
  finished: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  persistenceError?: boolean;
  finalizing?: boolean;
};

export class SessionService {
  private active?: ActiveRun;
  private closing = false;
  private unsaved?: Session;

  constructor(
    private readonly store: SessionStore,
    private readonly directory: string,
    private readonly emit: (event: DesktopEvent) => void,
  ) {
    store.recover();
  }

  list(): Session[] {
    if (this.unsaved) {
      const unsaved = this.unsaved;
      try {
        this.publish(unsaved);
        this.unsaved = undefined;
      } catch {
        return [
          structuredClone(unsaved),
          ...this.store.list().filter(session => session.id !== unsaved.id),
        ];
      }
    }
    return this.store.list();
  }

  create(input: CreateSessionInput): Session {
    let directory = input.directory;
    if (!directory) {
      directory = join(this.directory, 'workspaces', randomUUID());
      mkdirSync(directory, { recursive: true });
    }
    directory = this.resolveDirectory(directory);
    const session = this.store.create(input, directory);
    this.emit({ type: 'session-changed', session: structuredClone(session) });
    return session;
  }

  send(input: SendMessageInput): Session {
    if (this.unsaved) {
      this.list();
      if (this.unsaved)
        throw new SessionError(
          'busy',
          'Ostatnia odpowiedź nie została zapisana. Odśwież historię po przywróceniu dostępu do bazy.',
        );
    }
    const session = this.store.get(input.sessionId);
    if (!session)
      throw new SessionError(
        'not-found',
        'Nie znaleziono sesji. Odśwież listę.',
      );
    const existing = session.messages.find(
      message => message.id === input.messageId,
    );
    if (existing) {
      if (existing.author !== 'operator' || existing.body !== input.text)
        throw new SessionError(
          'invalid-request',
          'Identyfikator wiadomości jest już używany.',
        );
      return session;
    }
    if (this.closing || this.active)
      throw new SessionError(
        'busy',
        'Poczekaj na zakończenie aktywnej odpowiedzi lub użyj Stop.',
      );
    this.resolveDirectory(session.directory);
    if (JSON.stringify(session).length > 4_000_000)
      throw new SessionError(
        'invalid-request',
        'Ta rozmowa osiągnęła limit prototypu. Utwórz nową sesję.',
      );
    const runId = randomUUID();
    if (!session.providerInitialized && session.runId)
      session.providerSessionId =
        session.provider === 'Claude Code' ? randomUUID() : null;
    const createdAt = new Date().toISOString();
    session.runId = runId;
    session.status = 'running';
    session.error = null;
    session.pendingApprovals = [];
    session.activity = `Uruchamianie ${session.provider}…`;
    session.messages.push(
      {
        id: input.messageId,
        runId,
        author: 'operator',
        body: input.text,
        state: 'completed',
        createdAt,
      },
      {
        id: randomUUID(),
        runId,
        author: 'agent',
        body: '',
        state: 'running',
        createdAt,
      },
    );
    this.publish(session);
    const options = {
      directory: session.directory,
      resume: session.providerInitialized,
      model: session.model,
      prompt: input.text,
      onEvent: (event: ClaudeEvent | CodexEvent) => this.update(session, event),
    };
    const handle =
      session.provider === 'Codex'
        ? startCodex({
            ...options,
            sessionId: session.providerSessionId,
            mode: session.mode,
          })
        : startClaude({ ...options, sessionId: session.providerSessionId! });
    const active: ActiveRun = { session, handle, finished: Promise.resolve() };
    this.active = active;
    active.finished = handle.done
      .then(async result => {
        active.finalizing = true;
        if (active.timer) clearTimeout(active.timer);
        session.status = active.persistenceError ? 'failed' : result.status;
        session.error = active.persistenceError
          ? 'Zapis rozmowy nie powiódł się. Odpowiedź została zatrzymana.'
          : result.error;
        session.activity = null;
        session.pendingApprovals = [];
        const message = session.messages.at(-1)!;
        message.state = session.status;
        for (let attempt = 0; ; attempt++) {
          try {
            this.publish(session);
            break;
          } catch (error) {
            if (attempt === 2) throw error;
            await new Promise(resolve =>
              setTimeout(resolve, 150 * (attempt + 1)),
            );
          }
        }
      })
      .catch(() => {
        session.status = 'failed';
        session.error =
          'Nie udało się zapisać lub zakończyć odpowiedzi. Odśwież sesję przed kontynuowaniem.';
        session.activity = null;
        session.pendingApprovals = [];
        session.messages.at(-1)!.state = 'failed';
        session.revision += 1;
        this.unsaved = session;
        this.emit({
          type: 'session-changed',
          session: structuredClone(session),
        });
      })
      .finally(() => {
        if (active.timer) clearTimeout(active.timer);
        if (this.active === active) this.active = undefined;
      });
    return structuredClone(session);
  }

  stop(input: StopRunInput): Session {
    const active = this.active;
    if (
      !active ||
      active.session.id !== input.sessionId ||
      active.session.runId !== input.runId
    ) {
      const session = this.store.get(input.sessionId);
      if (!session)
        throw new SessionError('not-found', 'Nie znaleziono sesji.');
      return session;
    }
    if (active.finalizing) return structuredClone(active.session);
    active.session.status = 'stopping';
    active.session.activity = 'Zatrzymywanie…';
    active.session.pendingApprovals = [];
    try {
      this.publish(active.session);
    } finally {
      void active.handle.stop().catch(() => undefined);
    }
    return structuredClone(active.session);
  }

  respondApproval(input: RespondApprovalInput): Session {
    const active = this.active;
    if (
      !active ||
      active.session.id !== input.sessionId ||
      active.session.runId !== input.runId ||
      active.session.status !== 'running' ||
      active.session.mode !== 'supervised' ||
      !('respondApproval' in active.handle) ||
      !active.session.pendingApprovals.some(
        approval => approval.id === input.requestId,
      )
    )
      throw new SessionError(
        'invalid-request',
        'Ta prośba o zgodę nie jest już aktywna w tej sesji.',
      );
    const pending = active.session.pendingApprovals;
    active.session.pendingApprovals = pending.filter(
      approval => approval.id !== input.requestId,
    );
    try {
      this.publish(active.session);
    } catch (error) {
      active.session.pendingApprovals = pending;
      throw error;
    }
    try {
      active.handle.respondApproval(input.requestId, input.decision);
    } catch {
      void active.handle.stop().catch(() => undefined);
      throw new SessionError(
        'invalid-request',
        'Nie udało się przekazać decyzji. Sesja jest zatrzymywana.',
      );
    }
    return structuredClone(active.session);
  }

  async close(): Promise<void> {
    this.closing = true;
    const active = this.active;
    if (!active) return;
    if (active.finalizing) {
      await active.finished;
      return;
    }
    active.session.status = 'stopping';
    active.session.pendingApprovals = [];
    await active.handle.stop();
    await active.finished;
  }

  private update(session: Session, event: ClaudeEvent | CodexEvent): void {
    if (event.type === 'init') {
      if (
        (session.providerInitialized || session.provider === 'Claude Code') &&
        event.sessionId !== session.providerSessionId
      )
        throw new Error('Provider session mismatch');
      session.providerSessionId = event.sessionId;
      session.providerInitialized = true;
      session.actualModel = event.model;
      session.activity = `${session.provider} pracuje…`;
      this.publish(session);
    } else if (event.type === 'approval') {
      if (session.status !== 'running') return;
      if (session.provider !== 'Codex' || session.mode !== 'supervised')
        throw new Error('Unexpected provider approval');
      if (
        session.pendingApprovals.some(
          approval => approval.id === event.approval.id,
        )
      )
        throw new Error('Duplicate provider approval');
      session.pendingApprovals.push(event.approval);
      session.activity = 'Oczekiwanie na Twoją decyzję…';
      this.publish(session);
    } else if (event.type === 'approval-resolved') {
      session.pendingApprovals = session.pendingApprovals.filter(
        approval => approval.id !== event.id,
      );
      if (session.status === 'running' && !session.pendingApprovals.length)
        session.activity = `${session.provider} pracuje…`;
      this.publish(session);
    } else if (event.type === 'text') {
      session.messages.at(-1)!.body = event.text;
      session.activity =
        session.status === 'stopping' ? 'Zatrzymywanie…' : null;
    } else if (session.status !== 'stopping') {
      session.activity = event.text;
    }
    if (session.pendingApprovals.length)
      session.activity = 'Oczekiwanie na Twoją decyzję…';
    const active = this.active;
    if (active && !active.timer) {
      active.timer = setTimeout(() => {
        active.timer = undefined;
        try {
          this.publish(session);
        } catch {
          active.persistenceError = true;
          void active.handle.stop().catch(() => undefined);
        }
      }, 75);
    }
  }

  private publish(session: Session): void {
    this.store.save(session);
    this.emit({ type: 'session-changed', session: structuredClone(session) });
  }

  private resolveDirectory(directory: string): string {
    try {
      if (!isAbsolute(directory) || !statSync(directory).isDirectory())
        throw new Error('Invalid directory');
      return realpathSync(directory);
    } catch {
      throw new SessionError(
        'invalid-directory',
        'Katalog nie istnieje lub jest niedostępny. Podaj pełną ścieżkę do folderu.',
      );
    }
  }
}
