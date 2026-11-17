import {
  workflowDefinitionLimits,
  type CreateSessionInput,
  type DesktopEvent,
  type WorkflowIsolation,
  type WorkflowRun,
  type ResolvedWorkflow,
  type StartWorkflowTaskInput,
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
import { adoptLegacyFolder } from './legacy-folders';
import {
  BudgetRefusal,
  SessionError,
  confirmCodexEffort,
  type WorkflowTurnState,
  type RunFinished,
  type SessionService,
} from '../sessions/service';
import {
  WorkspaceIsolationError,
  createTaskWorktree,
  removeTaskWorktree,
  worktreeSlug,
} from '../workspace/isolation';
import {
  DefinitionError,
  loadCatalog,
  loadSpec,
  resolveWorkflow,
  resolveWriteRoots,
  type LoadedSpec,
} from './definitions';
import {
  WorkflowRunError,
  type AuthorPort,
  type AuthorTurn,
  type WorkflowRunner,
  type RunnerStore,
  turnMessageId,
} from './runner';

export const PLAN_INSTRUCTION =
  'Produce a plan for this task. Do not change files.';
export const IMPLEMENT_INSTRUCTION = 'Implement the task as planned.';

const PLAN_TEXT_LIMIT = 60_000;
const SNAPSHOT_FILE = /^([0-9a-f-]{36})\.md$/;

type AuthorSessions = Pick<
  SessionService,
  'turnState' | 'turnReply' | 'sendWorkflowTurn' | 'continueWithFeedback' | 'stopActive'
>;

type TaskSessions = Pick<SessionService, 'create' | 'isBusy' | 'onRunFinished'>;

type TaskStore = Pick<
  RunnerStore,
  'insertRun' | 'replaceRun' | 'getRun' | 'activeRunForDirectory' | 'prune'
>;

type TaskRunner = Pick<WorkflowRunner, 'advanceRun' | 'waitingForIdle'>;

export type TaskWorktrees = {
  create: typeof createTaskWorktree;
  remove: typeof removeTaskWorktree;
};

const gitWorktrees: TaskWorktrees = {
  create: createTaskWorktree,
  remove: removeTaskWorktree,
};

export class SpecSnapshots {
  private readonly root: string;

  constructor(dataDirectory: string) {
    this.root = adoptLegacyFolder(
      dataDirectory,
      'workflow-specs',
      'pipeline-specs',
    );
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
  run: Pick<WorkflowRun, 'id' | 'projectRoot'>,
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
  const send = (run: WorkflowRun, turn: AuthorTurn): 'sent' | 'busy' | 'unavailable' => {
    const sessionId = run.sessionId!;
    if (turn.kind === 'correction')
      return sessions.continueWithFeedback(sessionId, turn.prompt, turn.messageId);
    const spec = snapshots.read(run.id);
    if (spec === null) return 'unavailable';
    return turn.kind === 'plan'
      ? sessions.sendWorkflowTurn({
          sessionId,
          messageId: turn.messageId,
          text: planPrompt(spec),
          readOnly: true,
        })
      : sessions.sendWorkflowTurn({
          sessionId,
          messageId: turn.messageId,
          text: implementPrompt(
            spec,
            sessions.turnReply(sessionId, turnMessageId(run.id, 'plan', 1)),
          ),
        });
  };
  return {
    turnState: (run, messageId): WorkflowTurnState =>
      run.sessionId ? sessions.turnState(run.sessionId, messageId) : 'none',
    sendTurn: turn => {
      const run = store.getRun(turn.runId);
      if (!run?.sessionId) return 'unavailable';
      try {
        return send(run, turn);
      } catch (error) {
        if (error instanceof BudgetRefusal) return { refusal: error.message };
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
    for (const runId of runner.waitingForIdle())
      void runner.advanceRun(runId).catch(() => undefined);
  };
  const release = sessions.onRunFinished((finished: RunFinished) => {
    if (finished.workflowRunId)
      void runner.advanceRun(finished.workflowRunId).catch(() => undefined);
    idle();
  });
  return { idle, release };
};

const bounded = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

const isolationFailure = (error: WorkspaceIsolationError) =>
  new WorkflowRunError(
    error.code === 'timed-out' ||
      error.code === 'cancelled' ||
      error.code === 'git-unavailable' ||
      error.code === 'git-failed'
      ? 'unavailable'
      : 'invalid-request',
    error.message,
  );

const definitionFailure = (error: unknown): WorkflowRunError => {
  if (!(error instanceof DefinitionError))
    return new WorkflowRunError(
      'unavailable',
      'The task spec could not be read. Verify the folder and try again.',
    );
  if (error.kind === 'not-found' && error.issues.length === 0)
    return new WorkflowRunError('invalid-directory', error.message);
  if (error.kind === 'cancelled' || error.kind === 'timeout')
    return new WorkflowRunError('unavailable', error.message);
  const issues = error.issues
    .filter(issue => issue.severity === 'error')
    .slice(0, 8)
    .map(issue => `${issue.path}${issue.line ? `:${issue.line}` : ''}: ${issue.message}`);
  return new WorkflowRunError(
    'invalid-request',
    bounded([error.message, ...issues].join('\n'), 4000),
  );
};

export class WorkflowTasks {
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
    input: StartWorkflowTaskInput,
    signal: AbortSignal,
  ): Promise<WorkflowRun> {
    if (this.starting)
      throw new WorkflowRunError(
        'busy',
        'A workflow task is already starting. Try again shortly.',
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
    input: StartWorkflowTaskInput,
    signal: AbortSignal,
  ): Promise<WorkflowRun> {
    const directory = this.resolveDirectory(input.directory);
    const specPath = isAbsolute(input.specPath)
      ? input.specPath
      : join(directory, input.specPath);
    let projectRoot: string;
    let loaded: LoadedSpec;
    let workflow: ResolvedWorkflow;
    try {
      projectRoot = (await resolveWriteRoots(directory, signal)).projectRoot;
      this.ensureIdle(projectRoot);
      loaded = await loadSpec(specPath, directory, signal);
      workflow = resolveWorkflow(
        input.workflowName,
        await loadCatalog(directory, signal),
      );
    } catch (error) {
      if (error instanceof WorkflowRunError) throw error;
      throw definitionFailure(error);
    }
    if (input.effort) await confirmCodexEffort(input.model, input.effort, signal);
    this.ensureIdle(projectRoot);
    const runId = randomUUID();
    const title = bounded(
      input.title ??
        loaded.spec.title ??
        (basename(loaded.source.path, extname(loaded.source.path)) || 'Task spec'),
      workflowDefinitionLimits.specTitle,
    );
    let isolation: WorkflowIsolation | null = null;
    if (input.isolation === 'worktree') {
      try {
        isolation = await this.worktrees.create({
          projectDirectory: projectRoot,
          dataDirectory: this.ports.dataDirectory,
          slug: worktreeSlug(title, 'task'),
          runId,
          signal,
        });
      } catch (error) {
        if (error instanceof WorkspaceIsolationError) throw isolationFailure(error);
        throw new WorkflowRunError(
          'unavailable',
          'The task worktree could not be created. Try again.',
        );
      }
    }
    try {
      return this.record(input, {
        runId,
        title,
        projectRoot,
        loaded,
        workflow,
        isolation,
      });
    } catch (error) {
      if (isolation && !this.ports.store.getRun(runId))
        await this.worktrees
          .remove({
            projectDirectory: projectRoot,
            dataDirectory: this.ports.dataDirectory,
            worktree: isolation.worktree,
            signal: new AbortController().signal,
          })
          .catch(() => undefined);
      throw error;
    }
  }

  private get worktrees(): TaskWorktrees {
    return this.ports.worktrees ?? gitWorktrees;
  }

  private record(
    input: StartWorkflowTaskInput,
    {
      runId,
      title,
      projectRoot,
      loaded,
      workflow,
      isolation,
    }: {
      runId: string;
      title: string;
      projectRoot: string;
      loaded: LoadedSpec;
      workflow: ResolvedWorkflow;
      isolation: WorkflowIsolation | null;
    },
  ): WorkflowRun {
    this.ensureIdle(projectRoot);
    const runDirectory = isolation
      ? this.resolveDirectory(isolation.worktree)
      : projectRoot;
    this.ports.snapshots.write(runId, loaded.spec.body);
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: runId,
      revision: 1,
      workflow,
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
      throw new WorkflowRunError('unavailable', 'The run could not be saved. Try again.');
    this.ports.emit({ type: 'workflow-run-changed', run });
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
        origin: { kind: 'workflow', runId },
      }).id;
    } catch (error) {
      this.replace(run, {
        status: 'failed',
        attention: 'The task session could not be created.',
        finishedAt: new Date().toISOString(),
      });
      throw error instanceof SessionError
        ? error
        : new WorkflowRunError('unavailable', 'The task session could not be created.');
    }
    const linked = this.replace(run, { sessionId });
    if (!linked)
      throw new WorkflowRunError('unavailable', 'The run could not be linked to its session.');
    this.ports.store.prune(projectRoot);
    this.ports.snapshots.prune(id => Boolean(this.ports.store.getRun(id)));
    this.track(this.ports.runner.advanceRun(runId));
    return linked;
  }

  private replace(
    run: WorkflowRun,
    changes: Partial<Pick<WorkflowRun, 'sessionId' | 'status' | 'attention' | 'finishedAt'>>,
  ): WorkflowRun | null {
    const next: WorkflowRun = {
      ...run,
      ...changes,
      revision: run.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    if (!this.ports.store.replaceRun(next, run.revision)) return null;
    this.ports.emit({ type: 'workflow-run-changed', run: next });
    return next;
  }

  private ensureIdle(projectRoot: string): void {
    if (this.ports.store.activeRunForDirectory(projectRoot))
      throw new WorkflowRunError(
        'busy',
        'A workflow run is already active for this project. Stop it or wait until it ends.',
      );
    if (this.ports.sessions.isBusy())
      throw new WorkflowRunError(
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
      throw new WorkflowRunError(
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
