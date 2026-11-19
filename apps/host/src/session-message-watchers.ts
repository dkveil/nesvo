import { createHmac, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  sessionMessageWatcherDefinitionSchema,
  sessionMessageWatcherLineSchema,
  type SessionMessageWatcherDefinition,
  type SessionMessageWatcherInput,
  type SessionMessageWatcherReply,
} from '@nesvo/contracts';
import type { ExternalSessionIngress } from './external-session-ingress';
import { redactLogMessage } from './log-redaction';
import {
  DirectCommandReviewError,
  inspectDirectCommand,
  runDirectCommand,
} from './process/direct-command';
import { SessionError } from './sessions/session-error';
import { afterConfigurationCommit } from './workflows/assistant-change-store';
import { SetupNativeBindings } from './setup-native-bindings';
import type { LoadedSetupProfile } from './setup-profile-file';
import type { SetupProfileDeclaration } from '@nesvo/contracts';
import type { SetupNativeReview } from './setup-profile-review-queue';

type Watchers = Extract<SessionMessageWatcherReply, { action: 'read' }>;
type Entry = Watchers['history'][number];
type Watcher = Watchers['watchers'][number];
type Stored = {
  id: string;
  definition: string;
  revision: string;
  state: Watcher['state'];
  invalid_lines: number;
  delivered: number;
  detail: string | null;
  exit_code: number | null;
};
type Live = {
  leaseId: string;
  controller: AbortController;
  ends: number;
  expiry?: NodeJS.Timeout;
  finished?: Promise<void>;
  stopped?: string;
  pending: Set<Promise<void>>;
};
const leaseDuration = 40_000;
const lineLimit = 16 * 1024;
const viewDefinition = (row: Stored) =>
  sessionMessageWatcherDefinitionSchema.parse(JSON.parse(row.definition));
const refuse = (message: string): never => {
  throw new SessionError('invalid-request', message);
};

export class SessionMessageWatchers {
  private readonly live = new Map<string, Live>();
  private readonly key: string;
  private closing = false;
  private readonly profile: SetupNativeBindings;

  constructor(
    private readonly database: DatabaseSync,
    private readonly ingress: ExternalSessionIngress,
    private readonly activeSession: (id: string) => boolean,
  ) {
    this.profile = new SetupNativeBindings(
      database,
      'session-message-watchers',
    );
    database
      .prepare(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES ('watcher_key', ?)",
      )
      .run(randomUUID());
    this.key = String(
      database
        .prepare("SELECT value FROM metadata WHERE key = 'watcher_key'")
        .get()!.value,
    );
    for (const row of this.rows().filter(item => item.state === 'running')) {
      const detail = 'The host restarted. Start again to run this watcher.';
      database
        .prepare(
          "UPDATE session_message_watchers SET state = 'held', detail = ? WHERE id = ?",
        )
        .run(detail, row.id);
      this.log(randomUUID(), row.id, row.revision, 'held', detail, [
        row.id,
        'restart',
      ]);
    }
    ingress.watcherAuthorization = (id, sessionId, revision) => {
      const row = this.row(id);
      return (
        !!row &&
        this.profile.passes(id) &&
        id + ':' + row.revision === revision &&
        viewDefinition(row).allowedSessionIds.includes(sessionId)
      );
    };
  }

  async inspectFromProfile(
    profile: LoadedSetupProfile,
    declaration: SetupProfileDeclaration,
    definition: SessionMessageWatcherDefinition,
    signal: AbortSignal,
  ): Promise<SetupNativeReview> {
    const inspected = await this.inspect(definition, signal);
    const find = () =>
      this.rows().find(row => {
        const binding = this.profile.get(row.id);
        return (
          binding?.declaration === declaration.key &&
          binding.profile === profile.path
        );
      });
    const previous = find();
    const fingerprint = this.sign([
      inspected.revision,
      previous ? (this.profile.get(previous.id)?.generation ?? 0) : 0,
    ]);
    return {
      fingerprint,
      description: [
        'Watcher: ' + definition.name,
        'Working directory: ' + inspected.cwd,
        'Command: ' +
          JSON.stringify([inspected.executable, ...definition.command.argv]),
        'A separate Start action is required.',
      ]
        .map(line => redactLogMessage(line))
        .join('\n'),
      accept: () => {
        const current = find();
        if (current && this.live.has(current.id))
          return refuse(
            'Stop the existing watcher before approving a changed definition.',
          );
        if (!current && this.rows().length >= 20)
          return refuse(
            'Remove a saved watcher before saving a profile watcher.',
          );
        if (definition.allowedSessionIds.some(id => !this.activeSession(id)))
          return refuse('A watcher target is no longer active.');
        const id = current?.id ?? randomUUID();
        this.database
          .prepare(
            `
          INSERT INTO session_message_watchers (id, definition, revision, state)
          VALUES (?, ?, ?, 'idle')
          ON CONFLICT(id) DO UPDATE SET definition = excluded.definition,
            revision = excluded.revision, state = 'idle', detail = NULL, exit_code = NULL
        `,
          )
          .run(id, JSON.stringify(definition), inspected.revision);
        this.profile.bind(
          id,
          profile,
          declaration.key,
          declaration.revision,
          fingerprint,
        );
        this.log(randomUUID(), id, inspected.revision, 'approve', null, [
          profile.path,
          declaration.key,
        ]);
      },
      applied: () => {
        const row = find();
        return (
          !!row &&
          this.profile.get(row.id)?.fingerprint === fingerprint &&
          this.profile.passes(row.id)
        );
      },
      revoke: () => {
        const row = find();
        if (!row) return;
        this.profile.revoke(row.id);
        this.stopProfileWatchers([row.id]);
      },
    };
  }

  reconcileProfile(profile: LoadedSetupProfile | null) {
    this.stopProfileWatchers(this.profile.reconcile(profile));
  }

  private stopProfileWatchers(ids: string[]) {
    afterConfigurationCommit(this.database, () => {
      for (const id of ids) {
        const watcher = this.live.get(id);
        if (!watcher) continue;
        watcher.stopped =
          'The profile watcher changed or its local approval was revoked.';
        watcher.controller.abort();
      }
    });
  }

  private sign(value: unknown) {
    return createHmac('sha256', this.key)
      .update(JSON.stringify(value))
      .digest('hex');
  }

  private rows() {
    return this.database
      .prepare(
        'SELECT * FROM session_message_watchers ORDER BY rowid DESC LIMIT 20',
      )
      .all() as unknown as Stored[];
  }

  private row(id: string) {
    return this.database
      .prepare('SELECT * FROM session_message_watchers WHERE id = ?')
      .get(id) as Stored | undefined;
  }

  private log(
    id: string,
    watcherId: string,
    revision: string,
    action: Entry['action'],
    detail: string | null,
    payload: unknown,
  ) {
    this.database
      .prepare('INSERT INTO session_message_watcher_actions VALUES (?, ?, ?)')
      .run(
        id,
        this.sign(payload),
        JSON.stringify({
          id,
          watcherId,
          revision,
          action,
          detail,
          at: new Date().toISOString(),
        }),
      );
  }

  private previous(id: string, input: unknown) {
    const row = this.database
      .prepare(
        'SELECT payload, document FROM session_message_watcher_actions WHERE id = ?',
      )
      .get(id);
    if (row && row.payload !== this.sign(input))
      refuse('This watcher action ID is already in use.');
    return row ? (JSON.parse(String(row.document)) as Entry) : undefined;
  }

  private transaction(execute: () => void) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      execute();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private async inspect(
    definition: SessionMessageWatcherDefinition,
    signal: AbortSignal,
  ) {
    if (
      !isAbsolute(definition.directory) ||
      definition.command.files.some(path => !isAbsolute(path))
    )
      return refuse(
        'Use absolute paths for the watcher directory and artifacts.',
      );
    if (definition.allowedSessionIds.some(id => !this.activeSession(id)))
      return refuse('Select active sessions on this computer.');
    if (
      definition.command.argv.some(argument =>
        /(?:--?(?:token|password|api[-_]?key|secret|authorization)\b|:\/\/[^/\s]+@|<[a-zA-Z][a-zA-Z0-9]*>)/i.test(
          argument,
        ),
      )
    )
      return refuse('Use fixed arguments without credentials or placeholders.');
    const verified = await inspectDirectCommand(
      definition.command,
      definition.directory,
      this.sign(definition),
      this.key,
      signal,
    ).catch(error =>
      refuse(
        error instanceof DirectCommandReviewError
          ? error.message
          : 'The watcher executable, working directory or artifacts could not be verified.',
      ),
    );
    return {
      ...verified,
      revision: this.sign([definition, verified.fingerprint]),
    };
  }

  private read(): Watchers {
    return {
      action: 'read',
      watchers: this.rows().map(row => {
        const { name, source, defaultSessionId } = viewDefinition(row);
        return {
          id: row.id,
          revision: row.revision,
          state: row.state,
          name,
          source,
          defaultSessionId,
          invalidLines: row.invalid_lines,
          delivered: row.delivered,
          detail: row.detail,
          exitCode: row.exit_code,
        };
      }),
      history: this.database
        .prepare(
          'SELECT document FROM session_message_watcher_actions ORDER BY rowid DESC LIMIT 100',
        )
        .all()
        .map(row => JSON.parse(String(row.document)) as Entry),
    };
  }

  private renew(live: Live) {
    clearTimeout(live.expiry);
    live.ends = Date.now() + leaseDuration;
    live.expiry = setTimeout(() => {
      live.stopped =
        'The desktop lease expired. Start again to run this watcher.';
      live.controller.abort();
    }, leaseDuration);
    live.expiry.unref();
    return new Date(live.ends).toISOString();
  }

  async settings(
    input: SessionMessageWatcherInput,
    signal: AbortSignal,
  ): Promise<SessionMessageWatcherReply> {
    if (input.action === 'read') return this.read();
    if (input.action === 'renew') {
      const live = this.live.get(input.watcherId);
      const valid =
        live &&
        this.profile.passes(input.watcherId) &&
        live.leaseId === input.leaseId &&
        live.ends > Date.now() &&
        !live.controller.signal.aborted;
      return { action: 'renew', expiresAt: valid ? this.renew(live) : null };
    }
    if (this.closing) return refuse('The host is closing.');
    if (input.action === 'inspect') {
      const data = await this.inspect(input.definition, signal);
      return {
        action: 'inspect',
        cwd: data.cwd,
        executable: data.executable,
        revision: data.revision,
        argv: input.definition.command.argv.map(value =>
          redactLogMessage(value).slice(0, 4096),
        ),
      };
    }
    const earlier = this.previous(input.actionId, input);
    if (earlier) {
      if (input.action !== 'start') return { action: input.action };
      return {
        action: 'start',
        watcherId: input.watcherId,
        leaseId: null,
        expiresAt: null,
      };
    }
    if (input.action === 'approve') {
      const verified = await this.inspect(input.definition, signal);
      if (input.revision !== verified.revision)
        return refuse('The watcher changed. Review the definition again.');
      if (this.previous(input.actionId, input)) return { action: 'approve' };
      if (this.rows().length >= 20)
        return refuse('Remove a saved watcher first.');
      const watcherId = randomUUID();
      this.transaction(() => {
        this.database
          .prepare(
            "INSERT INTO session_message_watchers (id, definition, revision, state) VALUES (?, ?, ?, 'idle')",
          )
          .run(watcherId, JSON.stringify(input.definition), input.revision);
        this.log(
          input.actionId,
          watcherId,
          input.revision,
          'approve',
          null,
          input,
        );
      });
      return { action: 'approve' };
    }
    const row = this.row(input.watcherId);
    if (!row)
      throw new SessionError('not-found', 'The watcher no longer exists.');
    if (input.action === 'start') return this.start(input, row, signal);
    const action = input.action;
    if (action === 'revoke' && this.profile.get(row.id))
      return refuse(
        'This watcher is managed by the profile. Edit it in Your setup.',
      );
    this.transaction(() => {
      this.log(input.actionId, row.id, row.revision, action, null, input);
      if (action === 'revoke')
        this.database
          .prepare('DELETE FROM session_message_watchers WHERE id = ?')
          .run(row.id);
    });
    const live = this.live.get(row.id);
    if (live) {
      live.stopped =
        input.action === 'revoke'
          ? 'Watcher revoked.'
          : 'Stopped by the operator.';
      live.controller.abort();
      await live.finished;
    }
    return { action };
  }

  private async start(
    input: Extract<SessionMessageWatcherInput, { action: 'start' }>,
    row: Stored,
    signal: AbortSignal,
  ) {
    const definition = viewDefinition(row);
    if (!this.profile.passes(row.id))
      return refuse('Review the current profile watcher before starting it.');
    const verified = await this.inspect(definition, signal);
    if (this.previous(input.actionId, input))
      return {
        action: 'start' as const,
        watcherId: row.id,
        leaseId: null,
        expiresAt: null,
      };
    if (
      verified.revision !== row.revision ||
      !this.profile.passes(row.id) ||
      this.row(row.id)?.revision !== row.revision
    )
      return refuse(
        'The watcher changed or was revoked. Review it before starting.',
      );
    if (this.closing || this.live.has(row.id) || this.live.size >= 4)
      return refuse(
        'The watcher is running or this host has no free watcher slot.',
      );
    signal.throwIfAborted();
    const live: Live = {
      leaseId: randomUUID(),
      controller: new AbortController(),
      ends: 0,
      pending: new Set(),
    };
    this.transaction(() => {
      this.database
        .prepare(
          "UPDATE session_message_watchers SET state = 'running', invalid_lines = 0, delivered = 0, detail = NULL, exit_code = NULL WHERE id = ?",
        )
        .run(row.id);
      this.log(input.actionId, row.id, row.revision, 'start', null, input);
    });
    this.live.set(row.id, live);
    const expiresAt = this.renew(live);
    let partial = '';
    let skipping = false;
    const count = (column: 'invalid_lines' | 'delivered') => {
      this.database
        .prepare(
          `UPDATE session_message_watchers SET ${column} = ${column} + 1 WHERE id = ?`,
        )
        .run(row.id);
    };
    const active = () =>
      this.live.get(row.id) === live &&
      this.profile.passes(row.id) &&
      !live.controller.signal.aborted &&
      live.ends > Date.now();
    const authorized = {
      id: row.id,
      revision: row.revision,
      destination: definition.destination,
      sessions: definition.allowedSessionIds,
    };
    const post = (line: string) => {
      if (!line.trim() || !active()) return;
      if (live.pending.size >= 32 || Buffer.byteLength(line) > lineLimit)
        return count('invalid_lines');
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return count('invalid_lines');
      }
      const value = sessionMessageWatcherLineSchema.safeParse(raw);
      if (!value.success || !definition.kinds.includes(value.data.kind))
        return count('invalid_lines');
      const sessionId = value.data.sessionId ?? definition.defaultSessionId;
      if (!definition.allowedSessionIds.includes(sessionId))
        return count('invalid_lines');
      const delivery = this.ingress
        .watcher(
          { kind: 'watcher', id: row.id, label: definition.name },
          {
            idempotencyKey: value.data.eventId,
            kind: value.data.kind,
            source: definition.source,
            text: value.data.text,
            target: { kind: 'id', sessionId },
          },
          authorized,
          active,
        )
        .then(
          reply => count(reply.ok ? 'delivered' : 'invalid_lines'),
          () => count('invalid_lines'),
        )
        .catch(() => undefined)
        .finally(() => {
          live.pending.delete(delivery);
        });
      live.pending.add(delivery);
    };
    const onStdout = (chunk: string) => {
      for (const [index, fragment] of chunk.split('\n').entries()) {
        if (index > 0) {
          if (!skipping) post(partial);
          partial = '';
          skipping = false;
        }
        if (skipping) continue;
        partial += fragment;
        if (Buffer.byteLength(partial) > lineLimit) {
          partial = '';
          skipping = true;
          count('invalid_lines');
        }
      }
    };
    live.finished = Promise.resolve()
      .then(() =>
        runDirectCommand(
          definition.command,
          verified,
          {},
          live.controller.signal,
          onStdout,
        ),
      )
      .then(
        async result => {
          await Promise.allSettled(live.pending);
          const reason =
            live.stopped ??
            (result.timedOut
              ? 'The watcher reached its runtime limit.'
              : 'The watcher exited. Start again to continue.');
          this.finish(
            row,
            live,
            result.code,
            [reason, redactLogMessage(result.stderr).trim().slice(0, 650)]
              .filter(Boolean)
              .join(' '),
          );
        },
        async () => {
          await Promise.allSettled(live.pending);
          this.finish(
            row,
            live,
            null,
            live.stopped ?? 'The watcher process could not be confirmed.',
          );
        },
      );
    return {
      action: 'start' as const,
      watcherId: row.id,
      leaseId: live.leaseId,
      expiresAt,
    };
  }

  private finish(row: Stored, live: Live, code: number | null, detail: string) {
    clearTimeout(live.expiry);
    this.live.delete(row.id);
    if (!this.row(row.id)) return;
    const reason = detail.slice(0, 1024);
    this.database
      .prepare(
        "UPDATE session_message_watchers SET state = 'held', detail = ?, exit_code = ? WHERE id = ?",
      )
      .run(reason, code, row.id);
    this.log(randomUUID(), row.id, row.revision, 'held', reason, [
      row.id,
      code,
    ]);
  }

  async close() {
    this.closing = true;
    const live = [...this.live.values()];
    for (const active of live) {
      active.stopped = 'The host closed. Start again to run this watcher.';
      active.controller.abort();
    }
    await Promise.allSettled(live.map(active => active.finished));
  }
}
