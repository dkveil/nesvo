import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ScheduleError,
  collapseMissed,
  nextOccurrence,
  type DeleteScheduledJobInput,
  type DesktopEvent,
  type HostRequest,
  type ListScheduledJobRunsInput,
  type RunScheduledJobNowInput,
  type ScheduledJob,
  type ScheduledJobDefinition,
  type ScheduledJobRun,
  type ScheduledJobRunPage,
  type SetScheduledJobActiveInput,
} from '@nesvo/contracts';
import { SessionError, type SessionService } from '../sessions/service';
import { publicRun, type ScheduledJobStore, type StoredRun } from './store';

export const MAX_SCHEDULED_JOBS_PER_HOST = 20;
export const OPERATOR_IDLE_MS = 10 * 60_000;
export const MISSED_GRACE_MS = 2 * 60_000;
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const RETRY_DELAY_MS = 60_000;
const DEFAULT_RUN_PAGE = 20;

type SaveScheduledJobRequest = Extract<
  HostRequest,
  { method: 'save-scheduled-job' }
>['input'];

type ScheduledRunOutcome = Pick<
  ScheduledJobRun,
  'status' | 'reason' | 'missedCount'
>;

export type ScheduledJobLaunch = {
  scheduledJob: ScheduledJob;
  run: ScheduledJobRun;
};

export type ScheduledJobRunLink = Pick<ScheduledJobRun, 'sessionId' | 'runId'>;

export type ScheduledJobRunOutcome = Pick<
  ScheduledJobRun,
  'status' | 'reason' | 'reviewId'
>;

export type ScheduledJobRunProgress = {
  started: (link: ScheduledJobRunLink) => void;
  finished: (outcome: ScheduledJobRunOutcome) => void;
};

export type ScheduledJobLauncher = {
  launch: (
    launch: ScheduledJobLaunch,
    progress: ScheduledJobRunProgress,
  ) => Promise<void>;
  close?: () => void;
};

export type SchedulerClock = {
  now: () => Date;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

export type SessionAvailability = Pick<SessionService, 'isBusy' | 'isIdleFor'>;

export const systemClock: SchedulerClock = {
  now: () => new Date(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class ScheduledJobLaunchError extends Error {
  constructor(
    readonly reason: Extract<ScheduledJobRun['reason'], 'folder' | 'catalog'>,
    message: string,
  ) {
    super(message);
  }
}

export class ScheduledJobError extends Error {
  constructor(
    readonly code: 'busy' | 'not-found' | 'invalid-request',
    message: string,
  ) {
    super(message);
  }
}

const staleRevision = () =>
  new ScheduledJobError(
    'invalid-request',
    'This automation changed elsewhere. Refresh and try again.',
  );

export class ScheduledJobService {
  private timer: unknown;
  private closed = false;
  private readonly launches = new Set<Promise<void>>();

  constructor(
    private readonly store: ScheduledJobStore,
    private readonly sessions: SessionAvailability,
    private readonly launcher: ScheduledJobLauncher,
    private readonly emit: (event: DesktopEvent) => void,
    private readonly clock: SchedulerClock = systemClock,
  ) {}

  start(): void {
    this.fire();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.disarm();
    this.launcher.close?.();
    await Promise.all(this.launches);
  }

  list(): ScheduledJob[] {
    return this.store.list();
  }

  save(input: SaveScheduledJobRequest): ScheduledJob {
    const { id, expectedRevision, ...definition } = input;
    const current = this.store.get(id);
    if (expectedRevision === null) {
      if (current)
        throw new ScheduledJobError(
          'invalid-request',
          'This automation already exists. Refresh and try again.',
        );
      if (this.store.count() >= MAX_SCHEDULED_JOBS_PER_HOST)
        throw new ScheduledJobError(
          'invalid-request',
          `This host already has ${MAX_SCHEDULED_JOBS_PER_HOST} automations. Delete one before adding another.`,
        );
    } else this.current(current, expectedRevision);
    const now = this.clock.now();
    const reschedule =
      !current?.active ||
      !current.nextRunAt ||
      current.timeZone !== definition.timeZone ||
      !isDeepStrictEqual(current.schedule, definition.schedule);
    const job: ScheduledJob = {
      ...definition,
      id,
      revision: (current?.revision ?? 0) + 1,
      nextRunAt: definition.active
        ? reschedule
          ? this.firstRun(definition, now)
          : (current?.nextRunAt ?? null)
        : null,
      createdAt: current?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.write(job, expectedRevision);
    return job;
  }

  setActive(input: SetScheduledJobActiveInput): ScheduledJob {
    const current = this.current(
      this.store.get(input.id),
      input.expectedRevision,
    );
    if (current.active === input.active && (!input.active || current.nextRunAt))
      return current;
    const now = this.clock.now();
    const job: ScheduledJob = {
      ...current,
      active: input.active,
      revision: current.revision + 1,
      nextRunAt: input.active ? this.firstRun(current, now) : null,
      updatedAt: now.toISOString(),
    };
    this.write(job, input.expectedRevision);
    return job;
  }

  delete(input: DeleteScheduledJobInput): void {
    const current = this.current(
      this.store.get(input.id),
      input.expectedRevision,
    );
    if (this.store.hasActiveRun(current.id))
      throw new ScheduledJobError(
        'busy',
        'Wait for the current run of this automation to finish.',
      );
    if (!this.store.delete(current.id, input.expectedRevision))
      throw staleRevision();
    this.emit({
      type: 'scheduled-job-removed',
      scheduledJobId: current.id,
      revision: current.revision + 1,
    });
    this.arm();
  }

  listRuns(input: ListScheduledJobRunsInput): ScheduledJobRunPage {
    if (!this.store.get(input.scheduledJobId))
      throw new ScheduledJobError('not-found', 'Automation not found.');
    const page = this.store.listRuns(
      input.scheduledJobId,
      input.cursor ?? null,
      input.limit ?? DEFAULT_RUN_PAGE,
    );
    if (!page)
      throw new ScheduledJobError(
        'invalid-request',
        'This page of runs is no longer available. Refresh the history.',
      );
    return page;
  }

  runNow(input: RunScheduledJobNowInput): ScheduledJobRun {
    const recorded = this.store.runByRequest(input.requestId);
    if (recorded) {
      if (recorded.scheduledJobId !== input.id)
        throw new ScheduledJobError(
          'invalid-request',
          'This request ID is already in use.',
        );
      return publicRun(recorded);
    }
    const job = this.store.get(input.id);
    if (!job)
      throw new ScheduledJobError('not-found', 'Automation not found.');
    if (this.closed || this.sessions.isBusy() || this.store.hasActiveRun(job.id))
      throw new ScheduledJobError(
        'busy',
        'The host is busy. Try again when the current work has finished.',
      );
    const at = this.clock.now().toISOString();
    const run: StoredRun = {
      id: randomUUID(),
      scheduledJobId: job.id,
      scheduledFor: null,
      trigger: 'manual',
      status: 'starting',
      reason: null,
      missedCount: 0,
      sessionId: null,
      runId: null,
      reviewId: null,
      resetAt: null,
      startedAt: at,
      finishedAt: null,
      requestId: input.requestId,
      recordedAt: at,
    };
    this.store.transact(() => {
      this.store.insertRun(run);
      this.store.prune(job.id);
    });
    this.emitRun(run);
    this.launch(job, run);
    return publicRun(run);
  }

  tick(now = this.clock.now()): void {
    if (this.closed) return;
    let failure: unknown;
    for (const job of this.store.due(now)) {
      try {
        this.decide(job, now);
      } catch (error) {
        if (error instanceof ScheduleError) this.suspend(job, now);
        else failure ??= error;
      }
    }
    if (failure) throw failure;
    this.arm();
  }

  private decide(job: ScheduledJob, now: Date): void {
    const missed = collapseMissed(
      job.schedule,
      new Date(job.nextRunAt!),
      now,
      job.timeZone,
    );
    const outcome = this.outcome(job, now, missed.scheduledFor, missed.skipped);
    const at = now.toISOString();
    const starting = outcome.status === 'starting';
    const run: StoredRun = {
      id: randomUUID(),
      scheduledJobId: job.id,
      scheduledFor: missed.scheduledFor.toISOString(),
      trigger: 'schedule',
      ...outcome,
      sessionId: null,
      runId: null,
      reviewId: null,
      resetAt: null,
      startedAt: starting ? at : null,
      finishedAt: starting ? null : at,
      requestId: null,
      recordedAt: at,
    };
    const advanced: ScheduledJob = {
      ...job,
      revision: job.revision + 1,
      nextRunAt: missed.nextRunAt.toISOString(),
      updatedAt: at,
    };
    const claimed = this.store.transact(() => {
      if (!this.store.replace(advanced, job.revision)) return undefined;
      const inserted = this.store.insertRun(run);
      this.store.prune(job.id);
      return inserted;
    });
    if (claimed === undefined) return;
    this.emitJob(advanced);
    if (!claimed) return;
    this.emitRun(run);
    if (starting) this.launch(advanced, run);
  }

  private outcome(
    job: ScheduledJob,
    now: Date,
    scheduledFor: Date,
    skipped: number,
  ): ScheduledRunOutcome {
    if (now.getTime() - scheduledFor.getTime() > MISSED_GRACE_MS)
      return { status: 'skipped', reason: 'missed', missedCount: skipped + 1 };
    if (this.store.hasActiveRun(job.id))
      return { status: 'skipped', reason: 'overlap', missedCount: skipped };
    if (
      this.sessions.isBusy() ||
      !this.sessions.isIdleFor(OPERATOR_IDLE_MS, now)
    )
      return { status: 'skipped', reason: 'busy', missedCount: skipped };
    return { status: 'starting', reason: null, missedCount: skipped };
  }

  private suspend(job: ScheduledJob, now: Date): void {
    const suspended: ScheduledJob = {
      ...job,
      revision: job.revision + 1,
      nextRunAt: null,
      updatedAt: now.toISOString(),
    };
    if (this.store.replace(suspended, job.revision)) this.emitJob(suspended);
  }

  private launch(scheduledJob: ScheduledJob, run: StoredRun): void {
    const launching = Promise.resolve()
      .then(() =>
        this.launcher.launch(
          { scheduledJob, run: publicRun(run) },
          {
            started: link => this.markStarted(run.id, link),
            finished: outcome => this.markFinished(run.id, outcome),
          },
        ),
      )
      .catch(error => this.abandon(run.id, error))
      .catch(() => undefined)
      .finally(() => this.launches.delete(launching));
    this.launches.add(launching);
  }

  private abandon(runId: string, error: unknown): void {
    const run = this.store.run(runId);
    if (run?.status !== 'starting') return;
    const busy = error instanceof SessionError && error.code === 'busy';
    const abandoned: StoredRun = {
      ...run,
      ...this.abandonedOutcome(error),
      startedAt: busy ? null : run.startedAt,
      finishedAt: this.clock.now().toISOString(),
    };
    this.store.updateRun(abandoned);
    this.emitRun(abandoned);
  }

  private abandonedOutcome(
    error: unknown,
  ): Pick<ScheduledJobRun, 'status' | 'reason'> {
    if (this.closed) return { status: 'interrupted', reason: 'restart' };
    if (error instanceof SessionError && error.code === 'busy')
      return { status: 'skipped', reason: 'busy' };
    if (error instanceof ScheduledJobLaunchError)
      return { status: 'failed', reason: error.reason };
    return { status: 'failed', reason: null };
  }

  private markStarted(runId: string, link: ScheduledJobRunLink): void {
    const run = this.store.run(runId);
    if (run?.status !== 'starting') return;
    const running: StoredRun = { ...run, ...link, status: 'running' };
    this.store.updateRun(running);
    this.emitRun(running);
  }

  private markFinished(runId: string, outcome: ScheduledJobRunOutcome): void {
    const run = this.store.run(runId);
    if (run?.status !== 'running' && run?.status !== 'starting') return;
    const finished: StoredRun = {
      ...run,
      ...outcome,
      finishedAt: this.clock.now().toISOString(),
    };
    this.store.updateRun(finished);
    this.emitRun(finished);
  }

  private current(
    job: ScheduledJob | undefined,
    expectedRevision: number,
  ): ScheduledJob {
    if (!job)
      throw new ScheduledJobError('not-found', 'Automation not found.');
    if (job.revision !== expectedRevision) throw staleRevision();
    return job;
  }

  private firstRun(
    definition: Pick<ScheduledJobDefinition, 'schedule' | 'timeZone'>,
    now: Date,
  ): string {
    try {
      return nextOccurrence(
        definition.schedule,
        now,
        definition.timeZone,
      ).toISOString();
    } catch (error) {
      if (error instanceof ScheduleError)
        throw new ScheduledJobError('invalid-request', error.message);
      throw error;
    }
  }

  private write(job: ScheduledJob, expectedRevision: number | null): void {
    if (expectedRevision === null) this.store.insert(job);
    else if (!this.store.replace(job, expectedRevision)) throw staleRevision();
    this.emitJob(job);
    this.arm();
  }

  private emitJob(scheduledJob: ScheduledJob): void {
    this.emit({
      type: 'scheduled-job-changed',
      scheduledJob: structuredClone(scheduledJob),
    });
  }

  private emitRun(run: StoredRun): void {
    this.emit({ type: 'scheduled-job-run-changed', run: publicRun(run) });
  }

  private disarm(): void {
    if (this.timer != null) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.disarm();
    if (this.closed) return;
    const next = this.store.earliestNextRunAt();
    if (!next) return;
    const delay = Math.min(
      Math.max(Date.parse(next) - this.clock.now().getTime(), 0),
      MAX_TIMER_DELAY_MS,
    );
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined;
      this.fire();
    }, delay);
  }

  private fire(): void {
    try {
      this.tick();
    } catch {
      if (this.closed) return;
      console.error('Automations could not be checked. Retrying shortly.');
      this.disarm();
      this.timer = this.clock.setTimer(() => {
        this.timer = undefined;
        this.fire();
      }, RETRY_DELAY_MS);
    }
  }
}
