import { hostDiagnostic } from '../log-redaction';
import type { DatabaseSync } from 'node:sqlite';
import {
  SESSION_DELETE_GRACE_MS,
  isGroupableSession,
  type DeleteSessionInput,
  type DesktopEvent,
  type RestoreSessionInput,
  type Review,
  type Session,
  type SessionDeletion,
} from '@nesvo/contracts';
import { readRetentionDays, retentionCutoff } from './retention';
import { SessionError, type SessionService } from './service';

const MAX_TIMER_MS = 2 ** 31 - 1;
const WAITING_DELEGATIONS = new Set(['pending', 'planning', 'plan-ready']);

type DeletionReviews = { list: () => Review[] };

type TombstoneRow = {
  sessionId: string;
  rootId: string;
  deletedAt: string;
  purgeAfter: string;
  purgedAt: string | null;
};

export function sessionDeleteGraceMs(env: NodeJS.ProcessEnv = process.env) {
  const override = Number(env.NESVO_TEST_SESSION_DELETE_GRACE_MS);
  return env.NESVO_TEST_MODE === '1' &&
    Number.isInteger(override) &&
    override > 0
    ? override
    : SESSION_DELETE_GRACE_MS;
}

const waitsForOperator = (session: Session) =>
  session.pendingApprovals.length > 0 ||
  session.delegations.some(item => WAITING_DELEGATIONS.has(item.status));

export class SessionDeletions {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private retentionTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly database: DatabaseSync,
    private readonly sessions: SessionService,
    private readonly reviews: DeletionReviews,
    private readonly emit: (event: DesktopEvent) => void,
    private readonly graceMs = sessionDeleteGraceMs(),
    private readonly now = () => new Date(),
  ) {}

  start(): void {
    this.purgeExpired();
    this.runRetention();
    this.retentionTimer = setInterval(
      () => this.runRetention(),
      60 * 60 * 1000,
    ).unref();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.retentionTimer);
    clearTimeout(this.timer);
  }

  retention() {
    return { days: readRetentionDays(this.database), purgedSessions: 0 };
  }

  setRetention(days: number | null) {
    this.database
      .prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('transcript_retention_days', ?)",
      )
      .run(days?.toString() ?? '');
    return this.retention();
  }

  private runRetention() {
    void this.purgeRetained().catch(() =>
      hostDiagnostic('Expired transcripts could not be purged.'),
    );
  }

  async purgeRetained() {
    const { days } = this.retention();
    if (days === null) return { days, purgedSessions: 0 };
    const cutoff = retentionCutoff(days, this.now());
    const all = this.sessions.list();
    const reviewSessions = new Set(
      this.reviews
        .list()
        .filter(review => review.status === 'pending')
        .map(review => review.sessionId),
    );
    const targets = new Map<string, string>();
    for (const root of all) {
      if (!isGroupableSession(root) || root.workflowRunId || !root.archivedAt)
        continue;
      const tree = [root, ...this.descendants(root, all)];
      if (
        tree.some(
          item =>
            item.updatedAt >= cutoff.toISOString() ||
            item.queue.length > 0 ||
            this.sessions.isRunning(item.id) ||
            waitsForOperator(item) ||
            reviewSessions.has(item.id),
        )
      )
        continue;
      for (const item of tree) targets.set(item.id, root.id);
    }
    this.database
      .prepare('DELETE FROM transcript_files WHERE modified_at < ?')
      .run(cutoff.getTime());
    if (targets.size === 0) return { days, purgedSessions: 0 };
    const ids = [...targets.keys()];
    const deletion = this.purge(ids, targets);
    this.emit({ type: 'sessions-removed', sessionIds: ids });
    await deletion;
    return { days, purgedSessions: ids.length };
  }

  delete(input: DeleteSessionInput): SessionDeletion {
    const pending = this.pendingDeletion(input.sessionId);
    if (pending) return pending;
    const all = this.sessions.list();
    const session = all.find(item => item.id === input.sessionId);
    if (!session) throw new SessionError('not-found', 'Session not found.');
    if (!isGroupableSession(session))
      throw new SessionError(
        'invalid-request',
        'Subsessions and automation runs are deleted with their parent.',
      );
    if (session.workflowRunId)
      throw new SessionError(
        'invalid-request',
        'Sessions that belong to a workflow run stay with the run.',
      );
    const targets = [session, ...this.descendants(session, all)];
    if (targets.some(item => this.sessions.isRunning(item.id)))
      throw new SessionError(
        'busy',
        'Stop the session and its subsessions before deleting it.',
      );
    if (targets.some(waitsForOperator))
      throw new SessionError(
        'busy',
        'Answer the pending approvals and worker decisions before deleting the session.',
      );
    const deletedAt = this.now();
    const purgeAfter = new Date(deletedAt.getTime() + this.graceMs);
    this.transaction(() => {
      const insert = this.database.prepare(
        'INSERT INTO session_tombstones (session_id, root_id, deleted_at, purge_after) VALUES (?, ?, ?, ?)',
      );
      for (const target of targets)
        insert.run(
          target.id,
          session.id,
          deletedAt.toISOString(),
          purgeAfter.toISOString(),
        );
    });
    const sessionIds = targets.map(item => item.id);
    this.emit({ type: 'sessions-removed', sessionIds });
    this.arm();
    return {
      sessionId: session.id,
      sessionIds,
      title: session.title,
      deletedAt: deletedAt.toISOString(),
      purgeAfter: purgeAfter.toISOString(),
    };
  }

  restore(input: RestoreSessionInput): Session {
    const rows = this.tombstones(input.sessionId);
    const root = rows.find(row => row.sessionId === input.sessionId);
    if (!root)
      throw new SessionError(
        'not-found',
        'This session is not waiting to be deleted.',
      );
    if (root.purgedAt || Date.parse(root.purgeAfter) <= this.now().getTime()) {
      this.purgeExpired();
      throw new SessionError(
        'not-found',
        'The undo period ended and the session was deleted permanently.',
      );
    }
    const sessionIds = rows.map(row => row.sessionId);
    this.transaction(() => {
      this.database
        .prepare('DELETE FROM session_tombstones WHERE root_id = ?')
        .run(input.sessionId);
    });
    const restored = this.sessions.amend(sessionIds, () => {});
    const restoredIds = new Set(sessionIds);
    for (const review of this.reviews.list())
      if (restoredIds.has(review.sessionId))
        this.emit({ type: 'review-changed', review });
    this.arm();
    return restored.find(item => item.id === input.sessionId)!;
  }

  purgeExpired(): void {
    if (this.closed) return;
    const expired = this.database
      .prepare(
        'SELECT session_id AS sessionId FROM session_tombstones WHERE purged_at IS NULL AND purge_after <= ?',
      )
      .all(this.now().toISOString())
      .map(row => String(row.sessionId));
    if (expired.length) void this.purge(expired);
    this.arm();
  }

  private purge(sessionIds: string[], roots?: ReadonlyMap<string, string>) {
    const released = new Set(
      sessionIds.flatMap(sessionId =>
        this.attachmentIds('WHERE sessions.id = ?', sessionId),
      ),
    );
    const purgedAt = this.now().toISOString();
    this.transaction(() => {
      const statements = [
        'DELETE FROM history_entries WHERE session_id = ?',
        'DELETE FROM reviews WHERE session_id = ?',
        'DELETE FROM cost_turns WHERE session_id = ?',
        'DELETE FROM session_quarantine WHERE session_id = ?',
        "UPDATE sessions SET document = 'null', create_request_id = NULL WHERE id = ?",
      ].map(sql => this.database.prepare(sql));
      const mark = this.database.prepare(
        'UPDATE session_tombstones SET purged_at = ? WHERE session_id = ?',
      );
      if (roots) {
        const insert = this.database.prepare(
          'INSERT INTO session_tombstones (session_id, root_id, deleted_at, purge_after) VALUES (?, ?, ?, ?)',
        );
        for (const [id, root] of roots)
          insert.run(id, root, purgedAt, purgedAt);
      }
      for (const sessionId of sessionIds) {
        for (const statement of statements) statement.run(sessionId);
        mark.run(purgedAt, sessionId);
      }
    });
    for (const id of this.attachmentIds('')) released.delete(id);
    return this.releaseFiles(sessionIds, released);
  }

  private attachmentIds(filter: string, ...values: string[]): string[] {
    const references = (list: string) =>
      `SELECT attachment.value ->> '$.id' AS id FROM sessions, json_each(sessions.document, '$.${list}') AS item, json_each(item.value, '$.attachments') AS attachment ${filter}`;
    return this.database
      .prepare(`${references('messages')} UNION ${references('queue')}`)
      .all(...values, ...values)
      .map(row => String(row.id));
  }

  private async releaseFiles(
    sessionIds: readonly string[],
    contentIds: ReadonlySet<string>,
  ): Promise<void> {
    try {
      for (const sessionId of sessionIds)
        await this.sessions.attachments.removeSession(sessionId);
      await this.sessions.attachments.removeContent(contentIds);
    } catch {
      hostDiagnostic(
        'Attachment files of deleted sessions could not be removed.',
      );
    }
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    const next = this.database
      .prepare(
        'SELECT min(purge_after) AS next FROM session_tombstones WHERE purged_at IS NULL',
      )
      .get()?.next;
    if (typeof next !== 'string') return;
    const delay = Math.min(
      MAX_TIMER_MS,
      Math.max(0, Date.parse(next) - this.now().getTime()),
    );
    this.timer = setTimeout(() => {
      try {
        this.purgeExpired();
      } catch {
        hostDiagnostic('Deleted sessions could not be purged.');
      }
    }, delay);
    this.timer.unref?.();
  }

  private pendingDeletion(sessionId: string): SessionDeletion | undefined {
    const rows = this.tombstones(sessionId);
    const root = rows.find(row => row.sessionId === sessionId);
    if (!root || root.purgedAt) return;
    return {
      sessionId,
      sessionIds: rows.map(row => row.sessionId),
      title: String(
        this.database
          .prepare(
            "SELECT document ->> '$.title' AS title FROM sessions WHERE id = ?",
          )
          .get(sessionId)?.title ?? '',
      ),
      deletedAt: root.deletedAt,
      purgeAfter: root.purgeAfter,
    };
  }

  private tombstones(rootId: string): TombstoneRow[] {
    return this.database
      .prepare(
        'SELECT session_id AS sessionId, root_id AS rootId, deleted_at AS deletedAt, purge_after AS purgeAfter, purged_at AS purgedAt FROM session_tombstones WHERE root_id = ? ORDER BY session_id = root_id DESC, session_id',
      )
      .all(rootId)
      .map(row => ({
        sessionId: String(row.sessionId),
        rootId: String(row.rootId),
        deletedAt: String(row.deletedAt),
        purgeAfter: String(row.purgeAfter),
        purgedAt: row.purgedAt === null ? null : String(row.purgedAt),
      }));
  }

  private descendants(root: Session, all: Session[]): Session[] {
    const found: Session[] = [];
    const queue = [root.id];
    while (queue.length) {
      const parentId = queue.shift();
      for (const item of all)
        if (item.parentId === parentId && !found.includes(item)) {
          found.push(item);
          queue.push(item.id);
        }
    }
    return found;
  }

  private transaction(run: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
