import { createHash } from 'node:crypto';
import {
  createSessionSchema,
  type CreateSessionInput,
  type ScheduledJob,
  type WorkflowRun,
  type ScheduledJobRun,
  type Session,
  type StartWorkflowTaskInput,
} from '@nesvo/contracts';
import {
  BudgetRefusal,
  SessionError,
  confirmCodexEffort,
  type RunOutcome,
  type SessionService,
} from '../sessions/service';
import { WorkflowRunError } from '../workflows/runner';
import { FolderError, resolveFolder } from '../workspace/folder';
import { isRepositoryRoot } from '../workspace/isolation';
import { type ProviderUsageService } from '../providers/usage-service';
import { ProviderLimitGate } from './limit-gate';
import {
  OPERATOR_IDLE_MS,
  ScheduledJobLaunchError,
  ScheduledJobLimitError,
  systemClock,
  type ScheduledJobLaunch,
  type ScheduledJobLauncher,
  type ScheduledJobRunOutcome,
  type ScheduledJobRunProgress,
  type SchedulerClock,
} from './service';

const MINUTE_MS = 60_000;
const WORKFLOW_POLL_MS = 1_000;
const GATE_PROVIDERS = {
  claude: 'Codex',
  codex: 'Claude Code',
} as const satisfies Record<ScheduledJob['provider'], Session['provider']>;
const SESSION_PROVIDERS = {
  claude: 'Claude Code',
  codex: 'Codex',
} as const satisfies Record<ScheduledJob['provider'], Session['provider']>;

type LauncherSessions = Pick<
  SessionService,
  'create' | 'send' | 'stop' | 'finished' | 'isBusy' | 'isIdleFor'
>;

export type ScheduledReviews = {
  start: (job: ScheduledJob, runId: string) => Promise<number>;
};

export type ScheduledWorkflows = {
  start: (
    input: StartWorkflowTaskInput,
    signal: AbortSignal,
  ) => Promise<WorkflowRun>;
  getRun: (runId: string) => WorkflowRun | undefined;
  stop: (runId: string) => unknown;
};

const WORKFLOW_SETTLED = new Set<WorkflowRun['status']>([
  'passed',
  'failed',
  'rejected',
  'stopped',
  'interrupted',
]);

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
    return {
      status: 'completed',
      reason: null,
      reviewId: outcome.reviewId,
      resetAt: null,
    };
  if (outcome.state === 'failed' && outcome.limit)
    return {
      status: 'unavailable',
      reason: 'limit',
      reviewId: null,
      resetAt: outcome.limit.resetsAt,
    };
  if (timedOut && (outcome.state === 'stopped' || outcome.state === 'failed'))
    return { status: 'failed', reason: 'timeout', reviewId: null, resetAt: null };
  if (outcome.state === 'stopped')
    return { status: 'stopped', reason: null, reviewId: null, resetAt: null };
  if (outcome.state === 'interrupted')
    return {
      status: 'interrupted',
      reason: outcome.interruption === 'provider-disconnected' ? null : 'restart',
      reviewId: null,
      resetAt: null,
    };
  return { status: 'failed', reason: null, reviewId: null, resetAt: null };
};

const toWorkflowOutcome = (
  status: WorkflowRun['status'],
  timedOut: boolean,
): ScheduledJobRunOutcome => {
  if (status === 'passed')
    return { status: 'completed', reason: null, reviewId: null, resetAt: null };
  if (status === 'stopped')
    return timedOut
      ? { status: 'failed', reason: 'timeout', reviewId: null, resetAt: null }
      : { status: 'stopped', reason: null, reviewId: null, resetAt: null };
  if (status === 'interrupted')
    return {
      status: 'interrupted',
      reason: null,
      reviewId: null,
      resetAt: null,
    };
  return { status: 'failed', reason: null, reviewId: null, resetAt: null };
};

const workflowStartFailure = (error: unknown, directory: string): unknown => {
  if (error instanceof SessionError && error.code === 'invalid-request')
    return new ScheduledJobLaunchError('catalog', error.message);
  if (!(error instanceof WorkflowRunError)) return error;
  if (error.code === 'busy') return new SessionError('busy', error.message);
  if (error.code === 'invalid-request')
    return new ScheduledJobLaunchError('catalog', error.message);
  if (error.code === 'invalid-directory')
    return new ScheduledJobLaunchError(
      directory ? 'catalog' : 'folder',
      error.message,
    );
  return error;
};

export class SessionLauncher implements ScheduledJobLauncher {
  private readonly controller = new AbortController();
  private readonly deadlines = new Set<unknown>();
  private readonly limits: ProviderLimitGate;

  constructor(
    private readonly sessions: LauncherSessions,
    usage: Pick<ProviderUsageService, 'read'>,
    private readonly clock: DeadlineClock = systemClock,
    private readonly folders: typeof resolveFolder = resolveFolder,
    private readonly workflows: ScheduledWorkflows | null = null,
    private readonly repositories: typeof isRepositoryRoot = isRepositoryRoot,
    private readonly reviews: ScheduledReviews | null = null,
  ) {
    this.limits = new ProviderLimitGate(usage, () => this.clock.now());
  }

  async launch(
    { scheduledJob, run, operatorStarted }: ScheduledJobLaunch,
    progress: ScheduledJobRunProgress,
  ): Promise<void> {
    const signal = this.controller.signal;
    const limitedUntil = await this.limits.limitedUntil(scheduledJob.provider);
    if (limitedUntil) throw new ScheduledJobLimitError(limitedUntil);
    signal.throwIfAborted();
    const directory = scheduledJob.directory
      ? await this.folder(scheduledJob.directory, signal)
      : '';
    if (scheduledJob.pullRequestReview)
      return this.launchReviews(scheduledJob, run, progress);
    if (scheduledJob.workflow)
      return this.launchWorkflow(
        scheduledJob,
        scheduledJob.workflow,
        directory,
        run,
        progress,
        operatorStarted,
      );
    const input = sessionInput(scheduledJob, directory, this.runTime(run));
    if (input.effort) await this.confirmEffort(input, signal);
    signal.throwIfAborted();
    this.ensureAvailable(run, operatorStarted);
    const { sessionId, runId } = this.start(input, scheduledJob, run);
    if (runId) this.watch(scheduledJob, sessionId, runId, progress);
    try {
      progress.started({ sessionId, runId });
      if (!runId)
        progress.finished({
          status: 'failed',
          reason: null,
          reviewId: null,
          resetAt: null,
        });
    } catch {
      return;
    }
  }

  close(): void {
    this.controller.abort();
    for (const deadline of this.deadlines) this.clock.clearTimer(deadline);
    this.deadlines.clear();
  }

  private ensureAvailable(run: ScheduledJobRun, operatorStarted?: boolean): void {
    if (
      this.sessions.isBusy() ||
      (run.trigger === 'schedule' &&
        !operatorStarted &&
        !this.sessions.isIdleFor(OPERATOR_IDLE_MS))
    )
      throw new SessionError(
        'busy',
        'The host became busy before the automation started.',
      );
  }

  private async launchWorkflow(
    scheduledJob: ScheduledJob,
    workflow: NonNullable<ScheduledJob['workflow']>,
    directory: string,
    run: ScheduledJobRun,
    progress: ScheduledJobRunProgress,
    operatorStarted?: boolean,
  ): Promise<void> {
    const signal = this.controller.signal;
    const workflows = this.workflows;
    if (!workflows)
      throw new ScheduledJobLaunchError(
        'catalog',
        'Workflows are not available on this host.',
      );
    const isolation =
      directory && (await this.repositories(directory, signal))
        ? 'worktree'
        : 'none';
    signal.throwIfAborted();
    this.ensureAvailable(run, operatorStarted);
    let started: WorkflowRun;
    try {
      started = await workflows.start(
        {
          specPath: workflow.specPath,
          workflowName: workflow.name,
          provider: SESSION_PROVIDERS[scheduledJob.provider],
          model: scheduledJob.model,
          ...(scheduledJob.effort ? { effort: scheduledJob.effort } : {}),
          mode: scheduledJob.mode,
          directory,
          isolation,
          gateProvider: GATE_PROVIDERS[scheduledJob.provider],
          gateModel: 'default',
        },
        signal,
      );
    } catch (error) {
      throw workflowStartFailure(error, directory);
    }
    this.watchWorkflow(scheduledJob, started.id, workflows, progress);
    try {
      progress.started({
        sessionId: started.sessionId,
        runId: null,
        workflowRunId: started.id,
      });
    } catch {
      return;
    }
  }

  private async launchReviews(
    scheduledJob: ScheduledJob,
    run: ScheduledJobRun,
    progress: ScheduledJobRunProgress,
  ): Promise<void> {
    if (!this.reviews)
      throw new ScheduledJobLaunchError(
        'catalog',
        'Pull request reviews are not available on this host.',
      );
    try {
      await this.reviews.start(scheduledJob, run.id);
    } catch (error) {
      throw new ScheduledJobLaunchError(
        'catalog',
        error instanceof Error
          ? error.message
          : 'The pull requests could not be listed.',
      );
    }
    try {
      progress.started({ sessionId: null, runId: null });
      progress.finished({
        status: 'completed',
        reason: null,
        reviewId: null,
        resetAt: null,
      });
    } catch {
      return;
    }
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
  ): { sessionId: string; runId: string | null } {
    let sessionId: string | undefined;
    try {
      const session = this.sessions.create(input, {
        origin: {
          kind: 'scheduled-job',
          scheduledJobId: scheduledJob.id,
          runId: run.id,
        },
      });
      sessionId = session.id;
      const started = this.sessions.send({
        sessionId,
        messageId: firstMessageId(run.id),
        text: scheduledJob.prompt,
      });
      return { sessionId, runId: started.runId! };
    } catch (error) {
      if (error instanceof BudgetRefusal && sessionId)
        return { sessionId, runId: null };
      if (error instanceof SessionError && error.code === 'invalid-directory')
        throw new ScheduledJobLaunchError('folder', error.message);
      throw error;
    }
  }

  private watchWorkflow(
    scheduledJob: ScheduledJob,
    workflowRunId: string,
    workflows: ScheduledWorkflows,
    progress: ScheduledJobRunProgress,
  ): void {
    let timedOut = false;
    let poll: unknown;
    const deadline = this.clock.setTimer(() => {
      timedOut = true;
      try {
        workflows.stop(workflowRunId);
      } catch {
        return;
      }
    }, scheduledJob.timeoutMinutes * MINUTE_MS);
    this.deadlines.add(deadline);
    const check = () => {
      this.deadlines.delete(poll);
      const status = this.settledStatus(workflows, workflowRunId);
      if (!status) return schedule();
      this.clock.clearTimer(deadline);
      this.deadlines.delete(deadline);
      try {
        progress.finished(toWorkflowOutcome(status, timedOut));
      } catch {
        return;
      }
    };
    const schedule = () => {
      poll = this.clock.setTimer(check, WORKFLOW_POLL_MS);
      this.deadlines.add(poll);
    };
    schedule();
  }

  private settledStatus(
    workflows: ScheduledWorkflows,
    workflowRunId: string,
  ): WorkflowRun['status'] | null {
    try {
      const status = workflows.getRun(workflowRunId)?.status;
      return status && WORKFLOW_SETTLED.has(status) ? status : null;
    } catch {
      return null;
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
        outcome => {
          const result = toRunOutcome(outcome, timedOut);
          if (result.resetAt)
            this.limits.remember(scheduledJob.provider, result.resetAt);
          return result;
        },
        (): ScheduledJobRunOutcome => ({
          status: 'failed',
          reason: null,
          reviewId: null,
          resetAt: null,
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
