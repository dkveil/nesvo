import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  externalSessionMessageEntrySchema,
  externalSessionRequestSchema,
  externalSessionRuleSchema,
  type ExternalSessionMessage,
  type ExternalSessionMessageEntry,
  type ExternalSessionReply,
  type ExternalSessionRule,
  type ExternalSessionSettings,
  type ExternalSessionSettingsInput,
  type Session,
  type SessionIngressReceipt,
} from '@nesvo/contracts';
import type { ExternalInbox } from './external-inbox';
import type { InboxRules } from './inbox-rules/service';
import { SessionError } from './sessions/session-error';

type Issuer = SessionIngressReceipt['provenance'];
type Status = SessionIngressReceipt['status'];
type Destination = SessionIngressReceipt['destination'];
type Row = Record<string, unknown>;
type RouteDecision = ExternalSessionSettings['rulesHistory'][number];
type Target = Pick<Session, 'id' | 'groupId' | 'title' | 'archivedAt'>;
type Authorization = {
  id: string;
  revision: string;
  destination: Destination;
  sessions: string[];
};
const maximumPending = 12;
const maximumHostPending = 200;

const errors: Record<
  Extract<ExternalSessionReply, { ok: false }>['code'],
  string
> = {
  unauthorized:
    'This device and source have no grant for the requested message.',
  'invalid-request': 'The external session request is invalid.',
  'not-found':
    'Use an active session ID or an unambiguous exact title in a group.',
  conflict: 'This idempotency key belongs to a different message.',
  'rate-limit': 'The external session message rate limit was reached.',
  'pending-limit': 'The external session queue is full.',
  unavailable: 'External session delivery is unavailable.',
};

const failure = (code: keyof typeof errors): ExternalSessionReply => ({
  ok: false,
  code,
  message: errors[code],
});
const success = (receipt: SessionIngressReceipt): ExternalSessionReply => ({
  ok: true,
  receipt,
});
const parse = (row: Row) =>
  externalSessionMessageEntrySchema.parse(JSON.parse(String(row.document)));

export class ExternalSessionIngress {
  private readonly key: string;

  constructor(
    private readonly database: DatabaseSync,
    private readonly devices: ExternalInbox,
    private readonly inbox: InboxRules,
    private readonly session: (id: string) => Target | undefined,
    private readonly sessions: () => Target[],
    private readonly groups: () => { id: string; name: string }[],
  ) {
    database
      .prepare(
        "INSERT OR IGNORE INTO metadata (key, value) VALUES ('session_ingress_key', ?)",
      )
      .run(randomUUID());
    this.key = String(
      database
        .prepare("SELECT value FROM metadata WHERE key = 'session_ingress_key'")
        .get()!.value,
    );
    for (const row of database
      .prepare(
        "SELECT document FROM external_session_messages WHERE status IN ('routing', 'queued', 'delivering')",
      )
      .all()) {
      const entry = parse(row);
      const status = entry.receipt.status === 'queued' ? 'held' : 'uncertain';
      this.change(
        entry,
        status,
        'host',
        'The host restarted before delivery was confirmed.',
      );
    }
  }

  private sign(value: unknown) {
    return createHmac('sha256', this.key)
      .update(JSON.stringify(value))
      .digest('hex');
  }

  private rule(deviceId: string, source: string) {
    const row = this.database
      .prepare(
        'SELECT document FROM external_session_routes WHERE device_id = ? AND source = ?',
      )
      .get(deviceId, source);
    return row
      ? externalSessionRuleSchema.parse(JSON.parse(String(row.document)))
      : undefined;
  }

  private resolve(
    target: ExternalSessionMessage['target'],
    permitted: string[],
  ) {
    const allowed = (session: Target) =>
      !session.archivedAt &&
      (!permitted.length || permitted.includes(session.id));
    if (target.kind === 'id') {
      const session = this.session(target.sessionId);
      return session && allowed(session) ? session : undefined;
    }
    const group = target.group;
    const ids =
      group.kind === 'id'
        ? this.groups().filter(value => value.id === group.id)
        : this.groups().filter(value => value.name === group.name);
    if (ids.length !== 1) return undefined;
    const matches = this.sessions().filter(
      session =>
        session.groupId === ids[0]!.id &&
        session.title === target.title &&
        allowed(session),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private change(
    entry: ExternalSessionMessageEntry,
    status: Status,
    actor: ExternalSessionMessageEntry['changes'][number]['actor'],
    reason: string | null = null,
    messageId: string | null = null,
    inboxId = entry.receipt.inboxId,
  ) {
    const receipt: SessionIngressReceipt = {
      ...entry.receipt,
      status,
      reason,
      inboxId,
    };
    const document = {
      receipt,
      text: entry.text,
      changes: [
        ...entry.changes.slice(-31),
        { action: status, actor, at: new Date().toISOString(), messageId },
      ],
    };
    this.database
      .prepare(
        'UPDATE external_session_messages SET status = ?, inbox_id = ?, message_id = ?, document = ? WHERE id = ?',
      )
      .run(status, inboxId, messageId, JSON.stringify(document), receipt.id);
    return receipt;
  }

  private transaction<T>(execute: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = execute();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async device(value: unknown, signal: AbortSignal) {
    const input = externalSessionRequestSchema.safeParse(value);
    if (!input.success) return failure('invalid-request');
    const { token, message } = input.data;
    const device = this.devices.authenticate(token);
    if (!device) return failure('unauthorized');
    const rule = this.rule(device.id, message.source);
    if (!rule || !rule.kinds.includes(message.kind))
      return failure('unauthorized');
    return this.ingest(
      { kind: 'device', id: device.id, label: device.name },
      message,
      rule,
      () =>
        !signal.aborted &&
        !!this.devices.authenticate(token) &&
        this.rule(device.id, message.source)?.revision === rule.revision,
    );
  }

  watcher(
    issuer: Issuer,
    message: ExternalSessionMessage,
    rule: Authorization,
    active: () => boolean,
  ) {
    return this.ingest(issuer, message, rule, active);
  }

  private async ingest(
    issuer: Issuer,
    message: ExternalSessionMessage,
    rule: Authorization,
    active: () => boolean,
  ): Promise<ExternalSessionReply> {
    if (!active()) return failure('unauthorized');
    const dedupe = this.sign(message.idempotencyKey);
    const payload = this.sign(message);
    const approved = rule.id + ':' + rule.revision;
    const before = this.database
      .prepare(
        'SELECT payload, document, rule_id FROM external_session_messages WHERE issuer = ? AND dedupe = ?',
      )
      .get(issuer.id, dedupe);
    if (before) {
      if (before.rule_id !== approved) return failure('unauthorized');
      return before.payload === payload
        ? success(parse(before).receipt)
        : failure('conflict');
    }
    const target =
      rule.destination === 'reject'
        ? undefined
        : this.resolve(message.target, rule.sessions);
    if (rule.destination !== 'reject' && !target) return failure('not-found');
    const minute = new Date(Date.now() - 60_000).toISOString();
    const bursts = this.database
      .prepare(
        "SELECT COUNT(*) AS host, SUM(issuer = ?) AS issuer, SUM(json_extract(document, '$.receipt.source') = ?) AS source FROM external_session_messages WHERE recorded_at >= ?",
      )
      .get(issuer.id, message.source, minute)!;
    if (
      Number(bursts.host) >= 60 ||
      Number(bursts.issuer) >= 10 ||
      Number(bursts.source) >= 12
    )
      return failure('rate-limit');
    if (
      target &&
      (message.kind === 'send' || rule.destination === 'inbox') &&
      this.queueFull(target.id)
    )
      return failure('pending-limit');
    const status =
      rule.destination === 'inbox'
        ? 'routing'
        : rule.destination === 'reject'
          ? 'rejected'
          : message.kind === 'send'
            ? 'queued'
            : 'notification';
    const receipt: SessionIngressReceipt = {
      id: randomUUID(),
      computerId: this.devices.computerId,
      source: message.source,
      provenance: issuer,
      destination: rule.destination,
      kind: message.kind,
      sessionId: target?.id ?? null,
      groupId: target?.groupId ?? null,
      status,
      at: new Date().toISOString(),
      inboxId: null,
      reason:
        status === 'rejected' ? 'The source route rejects this message.' : null,
    };
    const entry: ExternalSessionMessageEntry = {
      receipt,
      text: message.text,
      changes: [
        { actor: issuer.kind, action: status, at: receipt.at, messageId: null },
      ],
    };
    this.database
      .prepare(
        'INSERT INTO external_session_messages VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)',
      )
      .run(
        receipt.id,
        issuer.id,
        dedupe,
        payload,
        approved,
        receipt.sessionId,
        status,
        receipt.at,
        JSON.stringify(entry),
      );
    if (status !== 'routing') return success(receipt);
    try {
      const posted = await this.inbox.postExternal(
        issuer.id,
        issuer.label,
        {
          title: `Message from ${message.source}`,
          body: message.text,
          source: message.source,
          sessionId: target!.id,
          actions: ['Deliver', 'Dismiss'],
          idempotencyKey: receipt.id,
        },
        active,
        'inbox',
      );
      if (typeof posted === 'string') {
        this.change(entry, 'rejected', 'host', errors[posted]);
        return failure(posted);
      }
      return success(
        this.change(
          entry,
          'inbox',
          'host',
          'Waiting for an operator decision.',
          null,
          posted.id,
        ),
      );
    } catch {
      this.change(
        entry,
        'uncertain',
        'host',
        'Inbox routing could not be confirmed.',
      );
      return failure('unavailable');
    }
  }

  private queueFull(sessionId: string) {
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS host, SUM(session_id = ?) AS session FROM external_session_messages WHERE status IN ('routing', 'inbox', 'queued', 'held', 'delivering')",
      )
      .get(sessionId)!;
    return (
      Number(row.host) >= maximumHostPending ||
      Number(row.session) >= maximumPending
    );
  }

  private currentAuthorization(
    entry: ExternalSessionMessageEntry,
    approvedRevision: string,
  ) {
    const source = entry.receipt.provenance;
    const session = entry.receipt.sessionId
      ? this.session(entry.receipt.sessionId)
      : undefined;
    if (!session || session.archivedAt) return false;
    if (source.kind === 'watcher')
      return (
        this.watcherAuthorization?.(source.id, session.id, approvedRevision) ??
        false
      );
    const rule = this.rule(source.id, entry.receipt.source);
    return (
      !!rule &&
      rule.id + ':' + rule.revision === approvedRevision &&
      rule.destination !== 'reject' &&
      rule.kinds.includes(entry.receipt.kind) &&
      (!rule.sessions.length || rule.sessions.includes(session.id)) &&
      this.devices.hasDevice(source.id)
    );
  }

  watcherAuthorization?: (
    watcherId: string,
    sessionId: string,
    revision: string,
  ) => boolean;

  decideInbox(inboxId: string, answer: string) {
    const stored = this.database
      .prepare(
        "SELECT document, rule_id FROM external_session_messages WHERE inbox_id = ? AND status = 'inbox'",
      )
      .get(inboxId);
    if (!stored) return;
    const entry = parse(stored);
    if (answer === 'Dismiss')
      return this.change(entry, 'dismissed', 'operator');
    if (answer !== 'Deliver') return;
    if (!this.currentAuthorization(entry, String(stored.rule_id)))
      return this.change(
        entry,
        'rejected',
        'operator',
        'The source grant or target is unavailable.',
      );
    return this.change(
      entry,
      entry.receipt.kind === 'send' ? 'queued' : 'notification',
      'operator',
    );
  }

  claim(sessionId: string, messageId: string) {
    const rows = this.database
      .prepare(
        "SELECT document, rule_id FROM external_session_messages WHERE session_id = ? AND status = 'queued' ORDER BY recorded_at, id LIMIT 4",
      )
      .all(sessionId);
    return rows.flatMap(row => {
      const entry = parse(row);
      if (!this.currentAuthorization(entry, String(row.rule_id))) {
        this.change(
          entry,
          'held',
          'host',
          'The source grant or target requires review.',
        );
        return [];
      }
      this.change(entry, 'delivering', 'operator', null, messageId);
      return [
        {
          id: entry.receipt.id,
          source: entry.receipt.source,
          origin: entry.receipt.provenance.label,
          data: entry.text,
        },
      ];
    });
  }

  settle(
    sessionId: string,
    messageId: string,
    status: 'delivered' | 'uncertain',
  ) {
    this.transaction(() => {
      const rows = this.database
        .prepare(
          "SELECT document FROM external_session_messages WHERE session_id = ? AND message_id = ? AND status = 'delivering'",
        )
        .all(sessionId, messageId);
      for (const row of rows)
        this.change(
          parse(row),
          status,
          'host',
          status === 'uncertain'
            ? 'The provider outcome could not be confirmed.'
            : null,
          messageId,
        );
    });
  }

  settings(input: ExternalSessionSettingsInput): ExternalSessionSettings {
    if (input.action !== 'read' && input.action !== 'history') {
      const earlier = this.database
        .prepare('SELECT payload FROM external_session_actions WHERE id = ?')
        .get(input.actionId);
      if (earlier && earlier.payload !== this.sign(input))
        throw new SessionError(
          'invalid-request',
          'This external routing action ID is already in use.',
        );
      if (!earlier)
        this.transaction(() => {
          const at = new Date().toISOString();
          let decision: RouteDecision;
          if (input.action === 'save-route') {
            const values = input.rule;
            if (
              !this.devices.hasDevice(values.deviceId) ||
              values.sessions.some(id => !this.session(id))
            )
              throw new SessionError(
                'not-found',
                'The device or one of the target sessions is unavailable.',
              );
            const previous = this.rule(values.deviceId, values.source);
            const count = this.database
              .prepare('SELECT COUNT(*) AS count FROM external_session_routes')
              .get()!;
            if (!previous && Number(count.count) >= 128)
              throw new SessionError(
                'busy',
                'Remove a saved route before adding another.',
              );
            const rule: ExternalSessionRule = {
              ...values,
              id: previous?.id ?? randomUUID(),
              revision: this.sign([values, input.actionId]),
              at,
            };
            this.database
              .prepare(
                'INSERT INTO external_session_routes VALUES (?, ?, ?, ?) ON CONFLICT(device_id, source) DO UPDATE SET document = excluded.document',
              )
              .run(rule.id, rule.deviceId, rule.source, JSON.stringify(rule));
            decision = {
              actionId: input.actionId,
              action: input.action,
              target: rule.id,
              at,
              revision: rule.revision,
            };
          } else if (input.action === 'revoke-route') {
            const row = this.database
              .prepare(
                'SELECT document FROM external_session_routes WHERE id = ?',
              )
              .get(input.routeId);
            if (!row)
              throw new SessionError(
                'not-found',
                'This source route was already removed.',
              );
            const rule = externalSessionRuleSchema.parse(
              JSON.parse(String(row.document)),
            );
            this.database
              .prepare('DELETE FROM external_session_routes WHERE id = ?')
              .run(rule.id);
            decision = {
              actionId: input.actionId,
              action: input.action,
              target: rule.id,
              at,
              revision: rule.revision,
            };
          } else {
            const row = this.database
              .prepare(
                'SELECT document, rule_id FROM external_session_messages WHERE id = ?',
              )
              .get(input.receiptId);
            if (!row)
              throw new SessionError(
                'not-found',
                'This receipt was not found.',
              );
            const entry = parse(row);
            if (
              entry.receipt.status !== 'held' &&
              entry.receipt.status !== 'uncertain'
            )
              throw new SessionError(
                'invalid-request',
                'This message is no longer awaiting continuation.',
              );
            if (
              input.action === 'continue' &&
              (entry.receipt.kind !== 'send' ||
                !this.currentAuthorization(entry, String(row.rule_id)))
            )
              throw new SessionError(
                'invalid-request',
                'This message has no active delivery grant.',
              );
            this.change(
              entry,
              input.action === 'continue' ? 'queued' : 'dismissed',
              'operator',
            );
            decision = {
              actionId: input.actionId,
              action: input.action,
              target: entry.receipt.id,
              at,
              revision: this.sign(entry.receipt),
            };
          }
          this.database
            .prepare('INSERT INTO external_session_actions VALUES (?, ?, ?)')
            .run(input.actionId, this.sign(input), JSON.stringify(decision));
        });
    }
    return {
      routes: this.database
        .prepare(
          'SELECT document FROM external_session_routes ORDER BY rowid DESC LIMIT 128',
        )
        .all()
        .map(row =>
          externalSessionRuleSchema.parse(JSON.parse(String(row.document))),
        ),
      messages:
        input.action === 'history'
          ? this.database
              .prepare(
                'SELECT document FROM external_session_messages WHERE session_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 100',
              )
              .all(input.sessionId)
              .map(parse)
              .reverse()
          : this.database
              .prepare(
                'SELECT document FROM external_session_messages ORDER BY recorded_at DESC, rowid DESC LIMIT 100',
              )
              .all()
              .map(parse),
      rulesHistory: this.database
        .prepare(
          'SELECT document FROM external_session_actions ORDER BY rowid DESC LIMIT 100',
        )
        .all()
        .map(row => JSON.parse(String(row.document)) as RouteDecision),
    };
  }
}
