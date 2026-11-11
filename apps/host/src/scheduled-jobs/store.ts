import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  scheduledJobRunSchema,
  scheduledJobSchema,
  type ScheduledJob,
  type ScheduledJobRun,
  type ScheduledJobRunPage,
} from '@nesvo/contracts';

export const SCHEDULED_JOB_RUN_RETENTION = 100;

export type StoredRun = ScheduledJobRun & {
  requestId: string | null;
  recordedAt: string;
};

type Row = Record<string, SQLOutputValue>;

const text = (value: SQLOutputValue) => (value === null ? null : String(value));

const toJob = (row: Row): ScheduledJob =>
  scheduledJobSchema.parse({
    id: row.id,
    revision: row.revision,
    name: row.name,
    prompt: row.prompt,
    directory: row.directory,
    provider: row.provider,
    model: row.model,
    effort: text(row.effort ?? null),
    mode: row.mode,
    schedule: JSON.parse(String(row.schedule)),
    timeZone: row.time_zone,
    active: row.active === 1,
    timeoutMinutes: row.timeout_minutes,
    nextRunAt: text(row.next_run_at ?? null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toRun = (row: Row): StoredRun => ({
  ...scheduledJobRunSchema.parse({
    id: row.id,
    scheduledJobId: row.scheduled_job_id,
    scheduledFor: text(row.scheduled_for ?? null),
    trigger: row.trigger_kind,
    status: row.status,
    reason: text(row.reason ?? null),
    missedCount: row.missed_count,
    sessionId: text(row.session_id ?? null),
    runId: text(row.session_run_id ?? null),
    reviewId: text(row.review_id ?? null),
    resetAt: text(row.reset_at ?? null),
    startedAt: text(row.started_at ?? null),
    finishedAt: text(row.finished_at ?? null),
  }),
  requestId: text(row.request_id ?? null),
  recordedAt: String(row.recorded_at),
});

export const publicRun = (run: StoredRun): ScheduledJobRun => {
  const visible: Partial<StoredRun> = { ...run };
  delete visible.requestId;
  delete visible.recordedAt;
  return scheduledJobRunSchema.parse(visible);
};

const jobValues = (job: ScheduledJob) => [
  job.revision,
  job.name,
  job.prompt,
  job.directory,
  job.provider,
  job.model,
  job.effort,
  job.mode,
  JSON.stringify(job.schedule),
  job.timeZone,
  job.active ? 1 : 0,
  job.timeoutMinutes,
  job.nextRunAt,
  job.updatedAt,
];

const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f-]{36})$/;

export class ScheduledJobStore {
  constructor(private readonly database: DatabaseSync) {}

  transact<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  list(): ScheduledJob[] {
    return this.database
      .prepare('SELECT * FROM scheduled_jobs ORDER BY created_at, id')
      .all()
      .map(toJob);
  }

  get(id: string): ScheduledJob | undefined {
    const row = this.database
      .prepare('SELECT * FROM scheduled_jobs WHERE id = ?')
      .get(id);
    return row ? toJob(row) : undefined;
  }

  count(): number {
    return Number(
      this.database.prepare('SELECT count(*) AS total FROM scheduled_jobs').get()
        ?.total ?? 0,
    );
  }

  due(now: Date): ScheduledJob[] {
    return this.database
      .prepare(
        'SELECT * FROM scheduled_jobs WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, id',
      )
      .all(now.toISOString())
      .map(toJob);
  }

  earliestNextRunAt(): string | null {
    const row = this.database
      .prepare(
        'SELECT min(next_run_at) AS next FROM scheduled_jobs WHERE active = 1',
      )
      .get();
    return text(row?.next ?? null);
  }

  insert(job: ScheduledJob): void {
    this.database
      .prepare(
        'INSERT INTO scheduled_jobs (revision, name, prompt, directory, provider, model, effort, mode, schedule, time_zone, active, timeout_minutes, next_run_at, updated_at, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(...jobValues(job), job.id, job.createdAt);
  }

  replace(job: ScheduledJob, expectedRevision: number): boolean {
    return (
      Number(
        this.database
          .prepare(
            'UPDATE scheduled_jobs SET revision = ?, name = ?, prompt = ?, directory = ?, provider = ?, model = ?, effort = ?, mode = ?, schedule = ?, time_zone = ?, active = ?, timeout_minutes = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND revision = ?',
          )
          .run(...jobValues(job), job.id, expectedRevision).changes,
      ) === 1
    );
  }

  delete(id: string, expectedRevision: number): boolean {
    return (
      Number(
        this.database
          .prepare('DELETE FROM scheduled_jobs WHERE id = ? AND revision = ?')
          .run(id, expectedRevision).changes,
      ) === 1
    );
  }

  insertRun(run: StoredRun): boolean {
    return (
      Number(
        this.database
          .prepare(
            'INSERT INTO scheduled_job_runs (id, scheduled_job_id, scheduled_for, request_id, trigger_kind, status, reason, missed_count, session_id, session_run_id, review_id, reset_at, recorded_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          )
          .run(
            run.id,
            run.scheduledJobId,
            run.scheduledFor,
            run.requestId,
            run.trigger,
            run.status,
            run.reason,
            run.missedCount,
            run.sessionId,
            run.runId,
            run.reviewId,
            run.resetAt,
            run.recordedAt,
            run.startedAt,
            run.finishedAt,
          ).changes,
      ) === 1
    );
  }

  updateRun(run: StoredRun): void {
    this.database
      .prepare(
        'UPDATE scheduled_job_runs SET status = ?, reason = ?, session_id = ?, session_run_id = ?, review_id = ?, reset_at = ?, started_at = ?, finished_at = ? WHERE id = ?',
      )
      .run(
        run.status,
        run.reason,
        run.sessionId,
        run.runId,
        run.reviewId,
        run.resetAt,
        run.startedAt,
        run.finishedAt,
        run.id,
      );
  }

  run(id: string): StoredRun | undefined {
    const row = this.database
      .prepare('SELECT * FROM scheduled_job_runs WHERE id = ?')
      .get(id);
    return row ? toRun(row) : undefined;
  }

  runByRequest(requestId: string): StoredRun | undefined {
    const row = this.database
      .prepare('SELECT * FROM scheduled_job_runs WHERE request_id = ?')
      .get(requestId);
    return row ? toRun(row) : undefined;
  }

  hasActiveRun(scheduledJobId: string): boolean {
    return !!this.database
      .prepare(
        "SELECT 1 FROM scheduled_job_runs WHERE scheduled_job_id = ? AND status IN ('starting', 'running') LIMIT 1",
      )
      .get(scheduledJobId);
  }

  listRuns(
    scheduledJobId: string,
    cursor: string | null,
    limit: number,
  ): ScheduledJobRunPage | undefined {
    const position = cursor ? CURSOR_PATTERN.exec(cursor) : null;
    if (cursor && !position) return undefined;
    const rows = (
      position
        ? this.database
            .prepare(
              'SELECT * FROM scheduled_job_runs WHERE scheduled_job_id = ? AND (recorded_at < ? OR (recorded_at = ? AND id < ?)) ORDER BY recorded_at DESC, id DESC LIMIT ?',
            )
            .all(
              scheduledJobId,
              position[1]!,
              position[1]!,
              position[2]!,
              limit + 1,
            )
        : this.database
            .prepare(
              'SELECT * FROM scheduled_job_runs WHERE scheduled_job_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?',
            )
            .all(scheduledJobId, limit + 1)
    ).map(toRun);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      runs: page.map(publicRun),
      nextCursor:
        rows.length > limit && last ? `${last.recordedAt}|${last.id}` : null,
    };
  }

  prune(scheduledJobId: string): void {
    this.database
      .prepare(
        "DELETE FROM scheduled_job_runs WHERE scheduled_job_id = ? AND status NOT IN ('starting', 'running') AND id NOT IN (SELECT id FROM scheduled_job_runs WHERE scheduled_job_id = ? AND status NOT IN ('starting', 'running') ORDER BY recorded_at DESC, id DESC LIMIT ?)",
      )
      .run(scheduledJobId, scheduledJobId, SCHEDULED_JOB_RUN_RETENTION);
  }

  interruptActiveRuns(at: string): void {
    this.database
      .prepare(
        "UPDATE scheduled_job_runs SET status = 'interrupted', reason = 'restart', finished_at = ? WHERE status IN ('starting', 'running')",
      )
      .run(at);
  }
}
