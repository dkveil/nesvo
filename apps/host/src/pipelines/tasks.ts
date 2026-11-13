import {
  pipelineDefinitionLimits,
  type CreateSessionInput,
  type DesktopEvent,
  type PipelineIsolation,
  type PipelineRun,
  type ResolvedPipeline,
  type StartPipelineTaskInput,
} from '@nesvo/contracts';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import {
  SessionError,
  confirmCodexEffort,
  type PipelineTurnState,
  type RunFinished,
  type SessionService,
} from '../sessions/service';
import {
  WorkspaceIsolationError,
  createTaskWorktree,
} from '../workspace/isolation';
import {
  DefinitionError,
  loadCatalog,
  loadSpec,
  resolvePipeline,
  resolveWriteRoots,
  type LoadedSpec,
} from './definitions';
import {
  PipelineRunError,
  type AuthorPort,
  type AuthorTurn,
  type PipelineRunner,
  type RunnerStore,
  turnMessageId,
} from './runner';

export const PLAN_INSTRUCTION =
  'Produce a plan for this task. Do not change files.';
export const IMPLEMENT_INSTRUCTION = 'Implement the task as planned.';

const PLAN_TEXT_LIMIT = 60_000;
const TASK_SLUG_LENGTH = 40;
const SNAPSHOT_FILE = /^([0-9a-f-]{36})\.md$/;

type AuthorSessions = Pick<
  SessionService,
  'turnState' | 'turnReply' | 'sendPipelineTurn' | 'continueWithFeedback' | 'stopActive'
>;

type TaskSessions = Pick<SessionService, 'create' | 'isBusy' | 'onRunFinished'>;

type TaskStore = Pick<
  RunnerStore,
  'insertRun' | 'replaceRun' | 'getRun' | 'activeRunForDirectory' | 'prune'
>;

type TaskRunner = Pick<PipelineRunner, 'advanceRun' | 'waitingForIdle'>;

export type TaskWorktrees = typeof createTaskWorktree;

export class SpecSnapshots {
  private readonly root: string;

  constructor(dataDirectory: string) {
    this.root = join(dataDirectory, 'pipeline-specs');
  }

  write(runId: string, body: string): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(this.path(runId), body, { mode: 0o600 });
  }

  read(runId: string): string | null {
    try {
      return readFileSync(this.path(runId), 'utf8');
    } catch {
      return null;
    }
  }

  prune(exists: (runId: string) => boolean): void {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      const runId = SNAPSHOT_FILE.exec(name)?.[1];
      if (!runId || exists(runId)) continue;
      try {
        unlinkSync(join(this.root, name));
      } catch {
        continue;
      }
    }
  }

  private path(runId: string): string {
    return join(this.root, `${runId}.md`);
  }
}

export const runEnvironment = (
  run: Pick<PipelineRun, 'id' | 'projectRoot'>,
): Record<string, string> => ({
  NESVO_RUN_ID: run.id,
  NESVO_PROJECT_ROOT: run.projectRoot,
});

export const planPrompt = (spec: string) => `${spec}\n\n${PLAN_INSTRUCTION}`;

export const implementPrompt = (spec: string, plan: string | null) =>
  plan
    ? `${spec}\n\nPlan:\n${plan.slice(0, PLAN_TEXT_LIMIT)}\n\n${IMPLEMENT_INSTRUCTION}`
    : `${spec}\n\n${IMPLEMENT_INSTRUCTION}`;

export const createSessionAuthor = ({
  sessions,
  store,
  snapshots,
}: {
  sessions: AuthorSessions;
  store: Pick<RunnerStore, 'getRun'>;
  snapshots: Pick<SpecSnapshots, 'read'>;
}): AuthorPort => {
  const send = (run: PipelineRun, turn: AuthorTurn): 'sent' | 'busy' | 'unavailable' => {
    const sessionId = run.sessionId!;
    if (turn.kind === 'correction')
      return sessions.continueWithFeedback(sessionId, turn.prompt, turn.messageId);
    const spec = snapshots.read(run.id);
    if (spec === null) return 'unavailable';
    return turn.kind === 'plan'
      ? sessions.sendPipelineTurn({
          sessionId,
          messageId: turn.messageId,
          text: planPrompt(spec),
          readOnly: true,
        })
      : sessions.sendPipelineTurn({
          sessionId,
          messageId: turn.messageId,
          text: implementPrompt(
            spec,
            sessions.turnReply(sessionId, turnMessageId(run.id, 'plan', 1)),
          ),
        });
  };
  return {
    turnState: (run, messageId): PipelineTurnState =>
      run.sessionId ? sessions.turnState(run.sessionId, messageId) : 'none',
    sendTurn: turn => {
      const run = store.getRun(turn.runId);
      if (!run?.sessionId) return 'unavailable';
      try {
        return send(run, turn);
      } catch (error) {
        if (error instanceof SessionError && error.code === 'busy') return 'busy';
        return 'unavailable';
      }
    },
    stop: runId => {
      const sessionId = store.getRun(runId)?.sessionId;
      if (sessionId) sessions.stopActive(sessionId);
    },
  };
};

export const bindRunEvents = (
  sessions: Pick<TaskSessions, 'isBusy' | 'onRunFinished'>,
  runner: TaskRunner,
): { idle: () => void; release: () => void } => {
  const idle = () => {
    if (sessions.isBusy()) return;
    for (const runId of runner.waitingForIdle()) void runner.advanceRun(runId);
  };
  const release = sessions.onRunFinished((finished: RunFinished) => {
    if (finished.pipelineRunId) void runner.advanceRun(finished.pipelineRunId);
    idle();
  });
  return { idle, release };
};

const bounded = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

export const taskSlug = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, TASK_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug || 'task';
};

const isolationFailure = (error: WorkspaceIsolationError) =>
  new PipelineRunError(
    error.code === 'timed-out' ||
      error.code === 'cancelled' ||
      error.code === 'git-unavailable' ||
      error.code === 'git-failed'
      ? 'unavailable'
      : 'invalid-request',
    error.message,
  );

const definitionFailure = (error: unknown): PipelineRunError => {
  if (!(error instanceof DefinitionError))
    return new PipelineRunError(
      'unavailable',
      'The task spec could not be read. Verify the folder and try again.',
    );
  if (error.kind === 'not-found' && error.issues.length === 0)
    return new PipelineRunError('invalid-directory', error.message);
  if (error.kind === 'cancelled' || error.kind === 'timeout')
    return new PipelineRunError('unavailable', error.message);
  const issues = error.issues
    .filter(issue => issue.severity === 'error')
    .slice(0, 8)
    .map(issue => `${issue.path}${issue.line ? `:${issue.line}` : ''}: ${issue.message}`);
  return new PipelineRunError(
    'invalid-request',
    bounded([error.message, ...issues].join('\n'), 4000),
  );
};

export class PipelineTasks {
  private starting = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly ports: {
      store: TaskStore;
      runner: TaskRunner;
      sessions: TaskSessions;
      snapshots: SpecSnapshots;
      dataDirectory: string;
      emit: (event: DesktopEvent) => void;
      worktrees?: TaskWorktrees;
    },
  ) {}

  async start(
    input: StartPipelineTaskInput,
    signal: AbortSignal,
  ): Promise<PipelineRun> {
    if (this.starting)
      throw new PipelineRunError(
        'busy',
        'A pipeline task is already starting. Try again shortly.',
      );
    this.starting = true;
    try {
      return await this.begin(input, signal);
    } finally {
      this.starting = false;
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.pending);
  }

  private async begin(
    input: StartPipelineTaskInput,
    signal: AbortSignal,
  ): Promise<PipelineRun> {
    const directory = this.resolveDirectory(input.directory);
    const specPath = isAbsolute(input.specPath)
      ? input.specPath
      : join(directory, input.specPath);
    let projectRoot: string;
    let loaded: LoadedSpec;
    let pipeline: ResolvedPipeline;
    try {
      projectRoot = (await resolveWriteRoots(directory, signal)).projectRoot;
      this.ensureIdle(projectRoot);
      loaded = await loadSpec(specPath, directory, signal);
      pipeline = resolvePipeline(
        input.pipelineName,
        await loadCatalog(directory, signal),
      );
    } catch (error) {
      if (error instanceof PipelineRunError) throw error;
      throw definitionFailure(error);
    }
    if (input.effort) await confirmCodexEffort(input.model, input.effort, signal);
    this.ensureIdle(projectRoot);
    const runId = randomUUID();
    const title = bounded(
      input.title ??
        loaded.spec.title ??
        (basename(loaded.source.path, extname(loaded.source.path)) || 'Task spec'),
      pipelineDefinitionLimits.specTitle,
    );
    let isolation: PipelineIsolation | null = null;
    if (input.isolation === 'worktree') {
      try {
        isolation = await (this.ports.worktrees ?? createTaskWorktree)({
          projectDirectory: projectRoot,
          dataDirectory: this.ports.dataDirectory,
          slug: taskSlug(title),
          runId,
          signal,
        });
      } catch (error) {
        if (error instanceof WorkspaceIsolationError) throw isolationFailure(error);
        throw new PipelineRunError(
          'unavailable',
          'The task worktree could not be created. Try again.',
        );
      }
      this.ensureIdle(projectRoot);
    }
    const runDirectory = isolation
      ? this.resolveDirectory(isolation.worktree)
      : projectRoot;
    this.ports.snapshots.write(runId, loaded.spec.body);
    const now = new Date().toISOString();
    const run: PipelineRun = {
      id: runId,
      revision: 1,
      pipeline,
      specPath: loaded.source.path,
      specHash: loaded.source.contentHash,
      specTitle: title,
      sessionId: null,
      directory: runDirectory,
      projectRoot,
      isolation,
      gateProvider: input.gateProvider,
      gateModel: input.gateModel,
      status: 'pending',
      phase: null,
      currentStepIndex: null,
      attention: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    if (!this.ports.store.insertRun(run))
      throw new PipelineRunError('unavailable', 'The run could not be saved. Try again.');
    this.ports.emit({ type: 'pipeline-run-changed', run });
    const sessionInput: CreateSessionInput = {
      title: bounded(title, 100),
      provider: input.provider,
      model: input.model,
      mode: input.mode,
      directory: runDirectory,
      ...(input.effort ? { effort: input.effort } : {}),
    };
    let sessionId: string;
    try {
      sessionId = this.ports.sessions.create(sessionInput, {
        origin: { kind: 'pipeline', runId },
      }).id;
    } catch (error) {
      this.replace(run, {
        status: 'failed',
        attention: 'The task session could not be created.',
        finishedAt: new Date().toISOString(),
      });
      throw error instanceof SessionError
        ? error
        : new PipelineRunError('unavailable', 'The task session could not be created.');
    }
    const linked = this.replace(run, { sessionId });
    if (!linked)
      throw new PipelineRunError('unavailable', 'The run could not be linked to its session.');
    this.ports.store.prune(projectRoot);
    this.ports.snapshots.prune(id => Boolean(this.ports.store.getRun(id)));
    this.track(this.ports.runner.advanceRun(runId));
    return linked;
  }

  private replace(
    run: PipelineRun,
    changes: Partial<Pick<PipelineRun, 'sessionId' | 'status' | 'attention' | 'finishedAt'>>,
  ): PipelineRun | null {
    const next: PipelineRun = {
      ...run,
      ...changes,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (!this.ports.store.replaceRun(next, run.revision)) return null;
    this.ports.emit({ type: 'pipeline-run-changed', run: next });
    return next;
  }

  private ensureIdle(projectRoot: string): void {
    if (this.ports.store.activeRunForDirectory(projectRoot))
      throw new PipelineRunError(
        'busy',
        'A pipeline run is already active for this project. Stop it or wait until it ends.',
      );
    if (this.ports.sessions.isBusy())
      throw new PipelineRunError(
        'busy',
        'Wait for the active session to finish or use Stop.',
      );
  }

  private resolveDirectory(directory: string): string {
    try {
      if (!isAbsolute(directory) || !statSync(directory).isDirectory())
        throw new Error('Invalid directory');
      return realpathSync(directory);
    } catch {
      throw new PipelineRunError(
        'invalid-directory',
        'The directory does not exist or cannot be accessed. Enter its absolute path.',
      );
    }
  }

  private track(promise: Promise<unknown>): void {
    const settled = promise.catch(() => undefined);
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }
}
