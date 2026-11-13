import { createHash } from 'node:crypto';
import {
  createSessionSchema,
  type CreateSessionInput,
  type ScheduledJob,
  type ScheduledJobRun,
  type Session,
} from '@nesvo/contracts';
import {
  SessionError,
  confirmCodexEffort,
  type RunOutcome,
  type SessionService,
} from '../sessions/service';
import { FolderError, resolveFolder } from '../workspace/folder';
import {
  OPERATOR_IDLE_MS,
  ScheduledJobLaunchError,
  systemClock,
  type ScheduledJobLaunch,
  type ScheduledJobLauncher,
  type ScheduledJobRunOutcome,
  type ScheduledJobRunProgress,
  type SchedulerClock,
} from './service';

const MINUTE_MS = 60_000;
const SESSION_PROVIDERS = {
  claude: 'Claude Code',
  codex: 'Codex',
} as const satisfies Record<ScheduledJob['provider'], Session['provider']>;

type LauncherSessions = Pick<
  SessionService,
  'create' | 'send' | 'stop' | 'finished' | 'isBusy' | 'isIdleFor'
>;

type DeadlineClock = Pick<SchedulerClock, 'now' | 'setTimer' | 'clearTimer'>;

export const firstMessageId = (runId: string): string => {
  const hex = createHash('sha256')
    .update(`scheduled-job-run:${runId}`)
    .digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const localDateTime = (at: Date, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

export const scheduledSessionTitle = (job: ScheduledJob, at: Date): string =>
  `${job.name} · ${localDateTime(at, job.timeZone)}`;

const sessionInput = (
  job: ScheduledJob,
  directory: string,
  at: Date,
): CreateSessionInput => {
  const parsed = createSessionSchema.safeParse({
    title: scheduledSessionTitle(job, at),
    provider: SESSION_PROVIDERS[job.provider],
    model: job.model,
    mode: job.mode,
    directory,
    ...(job.effort ? { effort: job.effort } : {}),
  });
  if (!parsed.success)
    throw new ScheduledJobLaunchError(
      'catalog',
      'The saved model or reasoning effort is not supported. No provider turn was started.',
    );
  return parsed.data;
};

const toRunOutcome = (
  outcome: RunOutcome,
  timedOut: boolean,
): ScheduledJobRunOutcome => {
  if (outcome.state === 'completed')
    return { status: 'completed', reason: null, reviewId: outcome.reviewId };
  if (timedOut && (outcome.state === 'stopped' || outcome.state === 'failed'))
    return { status: 'failed', reason: 'timeout', reviewId: null };
  if (outcome.state === 'stopped')
    return { status: 'stopped', reason: null, reviewId: null };
  if (outcome.state === 'interrupted')
    return {
      status: 'interrupted',
      reason: outcome.interruption === 'provider-disconnected' ? null : 'restart',
      reviewId: null,
    };
  return { status: 'failed', reason: null, reviewId: null };
};

export class SessionLauncher implements ScheduledJobLauncher {
  private readonly controller = new AbortController();
  private readonly deadlines = new Set<unknown>();

  constructor(
    private readonly sessions: LauncherSessions,
    private readonly clock: DeadlineClock = systemClock,
    private readonly folders: typeof resolveFolder = resolveFolder,
  ) {}

  async launch(
    { scheduledJob, run }: ScheduledJobLaunch,
    progress: ScheduledJobRunProgress,
  ): Promise<void> {
    const signal = this.controller.signal;
    const directory = scheduledJob.directory
      ? await this.folder(scheduledJob.directory, signal)
      : '';
    const input = sessionInput(scheduledJob, directory, this.runTime(run));
    if (input.effort) await this.confirmEffort(input, signal);
    signal.throwIfAborted();
    if (
      this.sessions.isBusy() ||
      (run.trigger === 'schedule' &&
        !this.sessions.isIdleFor(OPERATOR_IDLE_MS))
    )
      throw new SessionError(
        'busy',
        'The host became busy before the automation started.',
      );
    const { sessionId, runId } = this.start(input, scheduledJob, run);
    this.watch(scheduledJob, sessionId, runId, progress);
    try {
      progress.started({ sessionId, runId });
    } catch {
      return;
    }
  }

  close(): void {
    this.controller.abort();
    for (const deadline of this.deadlines) this.clock.clearTimer(deadline);
    this.deadlines.clear();
  }

  private runTime(run: ScheduledJobRun): Date {
    const at = run.scheduledFor ?? run.startedAt;
    return at ? new Date(at) : this.clock.now();
  }

  private async folder(directory: string, signal: AbortSignal) {
    try {
      return await this.folders(directory, signal);
    } catch (error) {
      if (error instanceof FolderError)
        throw new ScheduledJobLaunchError('folder', error.message);
      throw error;
    }
  }

  private async confirmEffort(
    input: CreateSessionInput,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await confirmCodexEffort(input.model, input.effort!, signal);
    } catch (error) {
      if (error instanceof SessionError && error.code === 'invalid-request')
        throw new ScheduledJobLaunchError('catalog', error.message);
      throw error;
    }
  }

  private start(
    input: CreateSessionInput,
    scheduledJob: ScheduledJob,
    run: ScheduledJobRun,
  ): { sessionId: string; runId: string } {
    try {
      const session = this.sessions.create(input, {
        origin: {
          kind: 'scheduled-job',
          scheduledJobId: scheduledJob.id,
          runId: run.id,
        },
      });
      const started = this.sessions.send({
        sessionId: session.id,
        messageId: firstMessageId(run.id),
        text: scheduledJob.prompt,
      });
      return { sessionId: session.id, runId: started.runId! };
    } catch (error) {
      if (error instanceof SessionError && error.code === 'invalid-directory')
        throw new ScheduledJobLaunchError('folder', error.message);
      throw error;
    }
  }

  private watch(
    scheduledJob: ScheduledJob,
    sessionId: string,
    runId: string,
    progress: ScheduledJobRunProgress,
  ): void {
    let timedOut = false;
    const deadline = this.clock.setTimer(() => {
      timedOut = true;
      try {
        this.sessions.stop({ sessionId, runId });
      } catch {
        return;
      }
    }, scheduledJob.timeoutMinutes * MINUTE_MS);
    this.deadlines.add(deadline);
    void this.sessions
      .finished(sessionId, runId)
      .then(
        outcome => toRunOutcome(outcome, timedOut),
        (): ScheduledJobRunOutcome => ({
          status: 'failed',
          reason: null,
          reviewId: null,
        }),
      )
      .then(outcome => {
        this.clock.clearTimer(deadline);
        this.deadlines.delete(deadline);
        progress.finished(outcome);
      })
      .catch(() => undefined);
  }
}
