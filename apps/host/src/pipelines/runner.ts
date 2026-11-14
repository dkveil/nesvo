import {
  pipelineLimits,
  stepResultSchema,
  type DefinitionCatalog,
  type DesktopEvent,
  type PipelineRun,
  type PipelineRunStatus,
  type PipelineStepRecord,
  type PipelineStepState,
  type ResolvedPipeline,
  type ResolvedStep,
  type RunPipelineStepsInput,
  type StepPhase,
  type StepResult,
  type StepType,
} from '@nesvo/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import {
  DefinitionError,
  loadCatalog,
  loadSpec,
  resolvePipeline,
  type LoadedSpec,
} from './definitions';
import { filterResultText, type EvidenceStore } from './evidence';
import type { PipelineRunStore } from './store';

export const NO_AUTHOR_ATTENTION = 'No author session on this host';
export const EXECUTOR_UNAVAILABLE = 'Executor not available';
export const MANUAL_GATE_PROVIDER = 'Claude Code';
export const MANUAL_GATE_MODEL = 'default';
export const AUTHOR_BUSY_MS = 60_000;
export const AUTHOR_BUSY_ATTENTION =
  'The computer was busy with another session';
export const AUTHOR_UNAVAILABLE_ATTENTION =
  'The task session is not available on this host.';

export type TurnState =
  | 'none'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export type TurnKind = 'plan' | 'implement' | 'correction';

export type AuthorTurn =
  | { runId: string; kind: 'plan' | 'implement'; messageId: string }
  | { runId: string; kind: 'correction'; prompt: string; messageId: string };

export type AuthorPort = {
  turnState: (run: PipelineRun, messageId: string) => TurnState;
  sendTurn: (turn: AuthorTurn) => 'sent' | 'busy' | 'unavailable';
  stop: (runId: string) => void;
};

const deterministicId = (seed: string): string => {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const turnMessageId = (
  runId: string,
  kind: TurnKind,
  attempt: number,
): string => deterministicId(`pipeline-turn:${runId}:${kind}:${attempt}`);

export const correctionMessageId = (
  runId: string,
  stepId: string,
  attempt: number,
): string =>
  deterministicId(`pipeline-turn:${runId}:correction:${stepId}:${attempt}`);

export type StepExecution = {
  run: PipelineRun;
  step: PipelineStepRecord;
  definition: ResolvedStep;
  outputs: ReadonlyMap<string, Readonly<Record<string, string>>>;
  signal: AbortSignal;
  evidence: StepEvidence;
  environment: NodeJS.ProcessEnv;
  now: () => Date;
  link: (sessionId: string) => void;
};

export type StepEvidence = Pick<
  EvidenceStore,
  'write' | 'recordProcess' | 'clearProcess'
>;

export type StepOutcome =
  | { kind: 'result'; result: StepResult }
  | { kind: 'skipped'; reason: string }
  | { kind: 'interrupted' }
  | {
      kind: 'awaiting-human';
      reviewId: string | null;
      reviewVersion: number | null;
      definitionChanges: string[];
    };

export type StepExecutor = (execution: StepExecution) => Promise<StepOutcome>;

export type RunnerStore = Pick<
  PipelineRunStore,
  | 'transact'
  | 'insertRun'
  | 'replaceRun'
  | 'getRun'
  | 'listRuns'
  | 'activeRunForDirectory'
  | 'insertStep'
  | 'replaceStep'
  | 'getStep'
  | 'stepsForRun'
  | 'beginStep'
  | 'prune'
  | 'unfinishedRunIds'
>;

export type RunnerDefinitions = {
  loadCatalog: (
    directory: string,
    signal: AbortSignal,
  ) => Promise<DefinitionCatalog>;
  loadSpec: (
    path: string,
    directory: string,
    signal: AbortSignal,
  ) => Promise<LoadedSpec>;
  resolvePipeline: (
    name: string,
    catalog: DefinitionCatalog,
  ) => ResolvedPipeline;
};

export type RunnerClock = {
  now: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export type RunnerPorts = {
  store: RunnerStore;
  definitions?: RunnerDefinitions;
  clock?: RunnerClock;
  emit: (event: DesktopEvent) => void;
  evidence: StepEvidence & Partial<Pick<EvidenceStore, 'stopOrphans'>>;
  stepExecutors: Record<StepType, StepExecutor>;
  author?: AuthorPort;
  environment?: NodeJS.ProcessEnv;
};

export class PipelineRunError extends Error {
  constructor(
    readonly code: 'busy' | 'not-found' | 'invalid-request' | 'invalid-directory' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export const unavailableExecutor: StepExecutor = () =>
  Promise.resolve({ kind: 'skipped', reason: EXECUTOR_UNAVAILABLE });

export const fileDefinitions: RunnerDefinitions = {
  loadCatalog,
  loadSpec,
  resolvePipeline,
};

const systemClock: RunnerClock = {
  now: () => new Date(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const TERMINAL_STATUSES: readonly PipelineRunStatus[] = [
  'passed',
  'failed',
  'rejected',
  'stopped',
  'interrupted',
];
const WAITING_STATUSES: readonly PipelineRunStatus[] = [
  'awaiting-human',
  'needs-attention',
  ...TERMINAL_STATUSES,
];
const AUTHOR_STATUSES: readonly PipelineRunStatus[] = [
  'pending',
  'planning',
  'implementing',
  'fixing',
];
const ACTIVE_STEP_STATES: readonly PipelineStepState[] = [
  'running',
  'awaiting-human',
  'uncertain',
];
const COMPLETE_STEP_STATES: readonly PipelineStepState[] = [
  'passed',
  'done',
  'skipped',
];
const VERDICT_STATES = {
  pass: 'passed',
  fail: 'failed',
  blocked: 'blocked',
  done: 'done',
  error: 'error',
} as const satisfies Record<StepResult['status'], PipelineStepState>;
const NEXT_PHASE = {
  plan: null,
  'pre-done': 'pre-push',
  'pre-push': null,
} as const satisfies Record<StepPhase, StepPhase | null>;

type Move =
  | { kind: 'wait' }
  | { kind: 'begin-phase'; phase: StepPhase }
  | { kind: 'status'; status: PipelineRunStatus }
  | { kind: 'attention'; message: string }
  | {
      kind: 'finish';
      status: 'passed' | 'failed' | 'stopped' | 'interrupted';
      message?: string;
    }
  | { kind: 'start-step'; step: PipelineStepRecord }
  | { kind: 'send-turn'; turn: AuthorTurn };

type MoveContext = {
  turnState: (messageId: string) => TurnState;
  hasAuthor: boolean;
};

const TURN_LABELS = {
  plan: 'planning',
  implement: 'implementation',
  correction: 'correction',
} as const satisfies Record<TurnKind, string>;

export const MISSING_CORRECTION_ATTENTION =
  'The correction requested at a gate could not be found.';

const WAIT: Move = { kind: 'wait' };

const bounded = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

export function latestAttempts(
  steps: readonly PipelineStepRecord[],
): Map<number, PipelineStepRecord> {
  const latest = new Map<number, PipelineStepRecord>();
  for (const step of steps) {
    const current = latest.get(step.index);
    if (!current || step.attempt >= current.attempt) latest.set(step.index, step);
  }
  return latest;
}

const phaseIndices = (pipeline: ResolvedPipeline, phase: StepPhase) =>
  pipeline.steps.flatMap((step, index) => (step.phase === phase ? [index] : []));

const failureAttention = (step: PipelineStepRecord) =>
  bounded(
    `Step "${step.name}" ${step.state === 'error' ? 'reported an error' : 'failed'}: ${step.result?.summary ?? 'no result was recorded.'}`,
    pipelineLimits.attention,
  );

const needsPlanningTurn = (pipeline: ResolvedPipeline) =>
  pipeline.steps.some(
    step =>
      step.phase === 'plan' && (step.type === 'agent' || step.type === 'human'),
  );

const afterImplementation = (run: PipelineRun): Move => {
  for (const phase of ['pre-done', 'pre-push'] as const)
    if (phaseIndices(run.pipeline, phase).length > 0)
      return { kind: 'begin-phase', phase };
  return { kind: 'finish', status: 'passed' };
};

const afterPlanning = (run: PipelineRun): Move =>
  phaseIndices(run.pipeline, 'plan').length > 0
    ? { kind: 'begin-phase', phase: 'plan' }
    : { kind: 'status', status: 'implementing' };

const authorTurn = (run: PipelineRun, kind: 'plan' | 'implement'): AuthorTurn => ({
  runId: run.id,
  kind,
  messageId: turnMessageId(run.id, kind, 1),
});

const turnMove = (
  state: TurnState,
  turn: AuthorTurn,
  completed: () => Move,
): Move => {
  const label = TURN_LABELS[turn.kind];
  if (state === 'none') return { kind: 'send-turn', turn };
  if (state === 'completed') return completed();
  if (state === 'failed')
    return {
      kind: 'attention',
      message: `The ${label} turn failed. Open the session for details.`,
    };
  if (state === 'stopped')
    return {
      kind: 'finish',
      status: 'stopped',
      message: `The ${label} turn was stopped.`,
    };
  if (state === 'interrupted')
    return {
      kind: 'finish',
      status: 'interrupted',
      message: `The ${label} turn was interrupted before it finished.`,
    };
  return WAIT;
};

const requestedCorrection = (
  run: PipelineRun,
  steps: readonly PipelineStepRecord[],
): { step: PipelineStepRecord; comment: string } | null => {
  if (!run.phase) return null;
  const latest = latestAttempts(steps);
  for (const index of phaseIndices(run.pipeline, run.phase)) {
    const step = latest.get(index);
    if (step?.state === 'failed' && step.decision?.kind === 'fix')
      return { step, comment: step.decision.comment };
  }
  return null;
};

const fixMove = (
  run: PipelineRun,
  steps: readonly PipelineStepRecord[],
  context: MoveContext,
): Move => {
  const correction = requestedCorrection(run, steps);
  if (!correction)
    return { kind: 'attention', message: MISSING_CORRECTION_ATTENTION };
  const turn: AuthorTurn = {
    runId: run.id,
    kind: 'correction',
    prompt: correction.comment,
    messageId: correctionMessageId(
      run.id,
      correction.step.id,
      correction.step.attempt,
    ),
  };
  return turnMove(context.turnState(turn.messageId), turn, () =>
    run.phase === 'plan'
      ? { kind: 'begin-phase', phase: 'plan' }
      : afterImplementation(run),
  );
};

const authorMove = (
  run: PipelineRun,
  steps: readonly PipelineStepRecord[],
  context: MoveContext,
): Move => {
  if (run.status === 'pending')
    return needsPlanningTurn(run.pipeline)
      ? { kind: 'status', status: 'planning' }
      : afterPlanning(run);
  if (run.status === 'planning') {
    const turn = authorTurn(run, 'plan');
    return turnMove(context.turnState(turn.messageId), turn, () =>
      afterPlanning(run),
    );
  }
  if (run.status === 'implementing') {
    const turn = authorTurn(run, 'implement');
    return turnMove(context.turnState(turn.messageId), turn, () =>
      afterImplementation(run),
    );
  }
  if (run.status === 'fixing') return fixMove(run, steps, context);
  return WAIT;
};

const completedPhase = (run: PipelineRun, context: MoveContext): Move => {
  if (!run.sessionId) return { kind: 'finish', status: 'passed' };
  if (!context.hasAuthor)
    return { kind: 'attention', message: NO_AUTHOR_ATTENTION };
  if (run.phase === 'plan') return { kind: 'status', status: 'implementing' };
  const next = run.phase ? NEXT_PHASE[run.phase] : null;
  return next && phaseIndices(run.pipeline, next).length > 0
    ? { kind: 'begin-phase', phase: next }
    : { kind: 'finish', status: 'passed' };
};

function nextMove(
  run: PipelineRun,
  steps: readonly PipelineStepRecord[],
  context: MoveContext,
): Move {
  if (WAITING_STATUSES.includes(run.status)) return WAIT;
  if (run.sessionId && AUTHOR_STATUSES.includes(run.status))
    return context.hasAuthor
      ? authorMove(run, steps, context)
      : { kind: 'attention', message: NO_AUTHOR_ATTENTION };
  if (run.status === 'pending')
    return run.phase && phaseIndices(run.pipeline, run.phase).length > 0
      ? { kind: 'begin-phase', phase: run.phase }
      : { kind: 'attention', message: 'The run has no steps to check.' };
  if (run.status !== 'checking' || !run.phase) return WAIT;
  const latest = latestAttempts(steps);
  const ordered = phaseIndices(run.pipeline, run.phase).map(index =>
    latest.get(index),
  );
  if (ordered.some(step => !step || ACTIVE_STEP_STATES.includes(step.state)))
    return WAIT;
  for (const step of ordered) {
    if (!step || COMPLETE_STEP_STATES.includes(step.state)) continue;
    if (step.state === 'pending') return { kind: 'start-step', step };
    if (step.state === 'failed' || step.state === 'error')
      return run.pipeline.steps[step.index]?.on_fail === 'fix'
        ? { kind: 'attention', message: failureAttention(step) }
        : { kind: 'finish', status: 'failed' };
    if (step.state === 'blocked')
      return {
        kind: 'attention',
        message: bounded(
          step.result?.summary || `Step "${step.name}" is blocked.`,
          pipelineLimits.attention,
        ),
      };
    return WAIT;
  }
  return completedPhase(run, context);
}

type PassState = { again: boolean; done: Promise<void> };
type BusyTurn = { timer: unknown; expired: boolean };
type ActiveStep = {
  controller: AbortController;
  done: Promise<void>;
};

export class PipelineRunner {
  private readonly store: RunnerStore;
  private readonly definitions: RunnerDefinitions;
  private readonly clock: RunnerClock;
  private readonly emit: (event: DesktopEvent) => void;
  private readonly evidence: RunnerPorts['evidence'];
  private readonly executors: Record<StepType, StepExecutor>;
  private readonly author: AuthorPort | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly passes = new Map<string, PassState>();
  private readonly active = new Map<string, ActiveStep>();
  private readonly busy = new Map<string, BusyTurn>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(ports: RunnerPorts) {
    this.store = ports.store;
    this.definitions = ports.definitions ?? fileDefinitions;
    this.clock = ports.clock ?? systemClock;
    this.emit = ports.emit;
    this.evidence = ports.evidence;
    this.executors = ports.stepExecutors;
    this.author = ports.author;
    this.environment = ports.environment ?? process.env;
  }

  async startManualRun(
    input: RunPipelineStepsInput,
    signal: AbortSignal,
  ): Promise<PipelineRun> {
    const directory = this.resolveDirectory(input.directory);
    const phase = input.phase ?? 'pre-done';
    const specPath = isAbsolute(input.specPath)
      ? input.specPath
      : join(directory, input.specPath);
    this.ensureIdle(directory);
    let loaded: LoadedSpec;
    let pipeline: ResolvedPipeline;
    try {
      loaded = await this.definitions.loadSpec(specPath, directory, signal);
      pipeline = this.definitions.resolvePipeline(
        loaded.spec.pipeline,
        await this.definitions.loadCatalog(directory, signal),
      );
    } catch (error) {
      throw definitionFailure(error);
    }
    if (phaseIndices(pipeline, phase).length === 0)
      throw new PipelineRunError(
        'invalid-request',
        `Pipeline "${pipeline.name}" has no steps in phase ${phase}.`,
      );
    if (this.closed)
      throw new PipelineRunError('unavailable', 'The host is shutting down.');
    this.ensureIdle(directory);
    const now = this.timestamp();
    const run: PipelineRun = {
      id: randomUUID(),
      revision: 1,
      pipeline,
      specPath: loaded.source.path,
      specHash: loaded.source.contentHash,
      specTitle: bounded(
        loaded.spec.title ??
          (basename(loaded.source.path, extname(loaded.source.path)) ||
            'Task spec'),
        100,
      ),
      sessionId: null,
      directory,
      projectRoot: directory,
      isolation: null,
      gateProvider: MANUAL_GATE_PROVIDER,
      gateModel: MANUAL_GATE_MODEL,
      status: 'pending',
      phase,
      currentStepIndex: null,
      attention: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    if (!this.store.insertRun(run))
      throw new PipelineRunError(
        'unavailable',
        'The run could not be saved. Try again.',
      );
    this.emit({ type: 'pipeline-run-changed', run });
    this.store.prune(directory);
    this.track(this.advanceRun(run.id));
    return run;
  }

  advanceRun(runId: string): Promise<void> {
    const current = this.passes.get(runId);
    if (current) {
      current.again = true;
      return current.done;
    }
    const state: PassState = { again: true, done: Promise.resolve() };
    state.done = Promise.resolve().then(() => {
      try {
        while (state.again && !this.closed) {
          state.again = false;
          this.pass(runId);
        }
      } finally {
        this.passes.delete(runId);
      }
    });
    this.passes.set(runId, state);
    return state.done;
  }

  stop(runId: string): PipelineRun {
    for (let attempt = 0; attempt < 8; attempt++) {
      const run = this.store.getRun(runId);
      if (!run) throw new PipelineRunError('not-found', 'Pipeline run not found.');
      if (TERMINAL_STATUSES.includes(run.status)) return run;
      const now = this.timestamp();
      const stopped: PipelineRun = {
        ...run,
        revision: run.revision + 1,
        status: 'stopped',
        updatedAt: now,
        finishedAt: now,
      };
      if (!this.store.replaceRun(stopped, run.revision)) continue;
      this.clearBusy(runId);
      this.emit({ type: 'pipeline-run-changed', run: stopped });
      if (run.sessionId) this.author?.stop(runId);
      this.active.get(runId)?.controller.abort('stop');
      this.track(this.advanceRun(runId));
      return stopped;
    }
    throw new PipelineRunError(
      'busy',
      'The run changed while it was being stopped. Try again.',
    );
  }

  recover(): Promise<void> {
    const ids = this.store.unfinishedRunIds();
    for (const id of ids) {
      const run = this.store.getRun(id);
      if (run && run.status === 'pending')
        this.writeRun(run, { status: 'interrupted', finishedAt: this.timestamp() });
    }
    const passes = Promise.resolve(this.evidence.stopOrphans?.())
      .catch(() => undefined)
      .then(() => Promise.all(ids.map(id => this.advanceRun(id))))
      .then(() => undefined);
    this.track(passes);
    return passes;
  }

  waitingForIdle(): string[] {
    return [...this.busy.entries()]
      .filter(([, turn]) => !turn.expired)
      .map(([runId]) => runId);
  }

  resume(runId: string): PipelineRun {
    const run = this.store.getRun(runId);
    if (!run) throw new PipelineRunError('not-found', 'Pipeline run not found.');
    if (run.status !== 'interrupted' && run.status !== 'needs-attention')
      throw new PipelineRunError(
        'invalid-request',
        'Only an interrupted run or a run that needs attention can be resumed.',
      );
    const latest = latestAttempts(this.store.stepsForRun(runId));
    const uncertain = [...latest.values()].find(
      step => step.state === 'uncertain',
    );
    if (uncertain)
      throw new PipelineRunError(
        'invalid-request',
        `Step \`${uncertain.name}\` may already have run. Mark it done or run it again.`,
      );
    const active = this.store.activeRunForDirectory(run.projectRoot);
    if (active && active.id !== run.id)
      throw new PipelineRunError(
        'busy',
        'A pipeline run is already active for this project. Stop it or wait until it ends.',
      );
    if (this.closed)
      throw new PipelineRunError('unavailable', 'The host is shutting down.');
    const turn = (kind: 'plan' | 'implement'): TurnState =>
      run.sessionId && this.author
        ? this.author.turnState(run, turnMessageId(run.id, kind, 1))
        : 'none';
    const retried = run.phase
      ? phaseIndices(run.pipeline, run.phase).flatMap(index => {
          const step = latest.get(index);
          return step && RESUMABLE_STEP_STATES.includes(step.state) ? [step] : [];
        })
      : [];
    const status = resumeStatus(run, latest, retried.length > 0, turn);
    const awaited =
      status === 'planning' ? 'plan' : status === 'implementing' ? 'implement' : null;
    if (awaited && DEAD_TURN_STATES.includes(turn(awaited)))
      throw new PipelineRunError(
        'invalid-request',
        `The ${TURN_LABELS[awaited]} turn did not finish, and a run never repeats a turn. Start a new task.`,
      );
    const now = this.timestamp();
    const next: PipelineRun = {
      ...run,
      revision: run.revision + 1,
      status,
      attention: null,
      finishedAt: null,
      updatedAt: now,
    };
    const created = retried.map(
      (step): PipelineStepRecord => ({
        ...step,
        id: randomUUID(),
        revision: 1,
        state: 'pending',
        attempt: step.attempt + 1,
        result: null,
        sessionId: null,
        reviewId: null,
        reviewVersion: null,
        skip: null,
        updatedAt: now,
        startedAt: null,
        decision: null,
        definitionChanges: [],
      }),
    );
    const written = this.store.transact(() => {
      if (!this.store.replaceRun(next, run.revision)) return false;
      for (const step of created)
        if (!this.store.insertStep(step)) throw new Error('Step row exists.');
      return true;
    });
    if (!written)
      throw new PipelineRunError(
        'busy',
        'The run changed while it was being resumed. Try again.',
      );
    this.emit({ type: 'pipeline-run-changed', run: next });
    for (const step of created) this.emit({ type: 'pipeline-step-changed', step });
    this.track(this.advanceRun(runId));
    return next;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const runId of [...this.busy.keys()]) this.clearBusy(runId);
    for (const step of this.active.values()) step.controller.abort('shutdown');
    while (this.pending.size > 0 || this.active.size > 0)
      await Promise.all([
        ...this.pending,
        ...[...this.active.values()].map(step => step.done),
      ]);
  }

  private pass(runId: string): void {
    const limit = pipelineLimits.stepsPerRun * 4 + 8;
    for (let iteration = 0; iteration < limit; iteration++) {
      const run = this.store.getRun(runId);
      if (!run) return;
      const steps = this.store.stepsForRun(runId);
      const author = this.author;
      const move = nextMove(run, steps, {
        turnState: messageId =>
          run.sessionId && author ? author.turnState(run, messageId) : 'none',
        hasAuthor: Boolean(author),
      });
      if (move.kind === 'wait' || this.closed) return;
      if (!this.perform(run, steps, move)) return;
    }
  }

  private perform(
    run: PipelineRun,
    steps: readonly PipelineStepRecord[],
    move: Exclude<Move, { kind: 'wait' }>,
  ): boolean {
    if (move.kind === 'begin-phase') this.beginPhase(run, move.phase);
    else if (move.kind === 'status') this.writeRun(run, { status: move.status });
    else if (move.kind === 'attention')
      this.writeRun(run, {
        status: 'needs-attention',
        attention: move.message,
      });
    else if (move.kind === 'finish')
      this.writeRun(run, {
        status: move.status,
        finishedAt: this.timestamp(),
        ...(move.message ? { attention: move.message } : {}),
      });
    else if (move.kind === 'send-turn') return this.sendTurn(run, move.turn);
    else this.startStep(run, steps, move.step);
    return true;
  }

  private sendTurn(run: PipelineRun, turn: AuthorTurn): boolean {
    const result = this.author!.sendTurn(turn);
    if (result === 'sent') {
      this.clearBusy(run.id);
      return true;
    }
    if (result === 'unavailable') {
      this.clearBusy(run.id);
      this.writeRun(run, {
        status: 'needs-attention',
        attention: AUTHOR_UNAVAILABLE_ATTENTION,
      });
      return true;
    }
    const waiting = this.busy.get(run.id);
    if (waiting?.expired) {
      this.clearBusy(run.id);
      this.writeRun(run, {
        status: 'needs-attention',
        attention: AUTHOR_BUSY_ATTENTION,
      });
      return true;
    }
    if (!waiting) {
      const entry: BusyTurn = { timer: null, expired: false };
      this.busy.set(run.id, entry);
      entry.timer = this.setTimer(() => {
        if (this.busy.get(run.id) !== entry) return;
        entry.expired = true;
        this.track(this.advanceRun(run.id));
      }, AUTHOR_BUSY_MS);
    }
    return false;
  }

  private setTimer(callback: () => void, delayMs: number): unknown {
    return this.clock.setTimer && this.clock.clearTimer
      ? this.clock.setTimer(callback, delayMs)
      : setTimeout(callback, delayMs);
  }

  private clearBusy(runId: string): void {
    const entry = this.busy.get(runId);
    if (!entry) return;
    this.busy.delete(runId);
    if (this.clock.setTimer && this.clock.clearTimer)
      this.clock.clearTimer(entry.timer);
    else clearTimeout(entry.timer as ReturnType<typeof setTimeout>);
  }

  private beginPhase(run: PipelineRun, phase: StepPhase): void {
    const now = this.timestamp();
    const indices = phaseIndices(run.pipeline, phase);
    const next: PipelineRun = {
      ...run,
      revision: run.revision + 1,
      status: 'checking',
      phase,
      currentStepIndex: indices[0] ?? null,
      attention: null,
      updatedAt: now,
    };
    const existing = latestAttempts(this.store.stepsForRun(run.id));
    const created: PipelineStepRecord[] = [];
    const written = this.store.transact(() => {
      if (!this.store.replaceRun(next, run.revision)) return false;
      for (const index of indices) {
        const definition = run.pipeline.steps[index]!;
        const attempt = (existing.get(index)?.attempt ?? 0) + 1;
        const step: PipelineStepRecord = {
          id: randomUUID(),
          runId: run.id,
          revision: 1,
          index,
          name: definition.name,
          type: definition.type,
          phase: definition.phase,
          state: 'pending',
          attempt,
          result: null,
          sessionId: null,
          reviewId: null,
          reviewVersion: null,
          skip: null,
          updatedAt: now,
          startedAt: null,
          decision: null,
          definitionChanges: [],
        };
        if (!this.store.insertStep(step)) throw new Error('Step row exists.');
        created.push(step);
      }
      return true;
    });
    if (!written) return;
    this.emit({ type: 'pipeline-run-changed', run: next });
    for (const step of created) this.emit({ type: 'pipeline-step-changed', step });
  }

  private startStep(
    run: PipelineRun,
    steps: readonly PipelineStepRecord[],
    step: PipelineStepRecord,
  ): void {
    const definition = run.pipeline.steps[step.index];
    if (!definition) return;
    const blocked = this.unmetNeed(definition);
    if (blocked) {
      const now = this.timestamp();
      this.writeStep(step, {
        state: 'blocked',
        result: this.verdict(step, 'blocked', blocked, now, now),
      });
      return;
    }
    if (run.currentStepIndex !== step.index)
      if (!this.writeRun(run, { currentStepIndex: step.index })) return;
    const running = this.store.beginStep(step.id, step.revision, this.timestamp());
    if (!running) return;
    this.emit({ type: 'pipeline-step-changed', step: running });
    const controller = new AbortController();
    const current = this.store.getRun(run.id) ?? run;
    const execution: StepExecution = {
      run: current,
      step: running,
      definition,
      outputs: earlierOutputs(steps, step.index),
      signal: controller.signal,
      evidence: this.evidence,
      environment: this.environment,
      now: () => this.clock.now(),
      link: sessionId => this.linkStep(running, sessionId),
    };
    const executor = this.executors[definition.type] ?? unavailableExecutor;
    const done = Promise.resolve()
      .then(() => executor(execution))
      .catch(
        (): StepOutcome => ({
          kind: 'result',
          result: this.verdict(
            running,
            definition.type === 'action' ? 'error' : 'fail',
            'The step could not run on this host.',
            running.startedAt ?? this.timestamp(),
            this.timestamp(),
          ),
        }),
      )
      .then(outcome => {
        if (controller.signal.reason === 'shutdown') return;
        this.finishStep(running, outcome);
      })
      .finally(() => {
        this.active.delete(run.id);
        if (!this.closed) this.track(this.advanceRun(run.id));
      });
    this.active.set(run.id, { controller, done });
  }

  private linkStep(running: PipelineStepRecord, sessionId: string): void {
    const current = this.store.getStep(running.id);
    if (
      current &&
      current.state === 'running' &&
      current.attempt === running.attempt
    )
      this.writeStep(current, { sessionId });
  }

  private finishStep(running: PipelineStepRecord, outcome: StepOutcome): void {
    const current = this.store.getStep(running.id);
    if (
      !current ||
      current.state !== 'running' ||
      current.attempt !== running.attempt
    )
      return;
    if (outcome.kind === 'interrupted') {
      this.writeStep(current, { state: 'interrupted', result: null });
      return;
    }
    if (outcome.kind === 'awaiting-human') {
      this.awaitHuman(current, outcome);
      return;
    }
    if (outcome.kind === 'skipped') {
      this.writeStep(current, {
        state: 'skipped',
        result: null,
        skip: {
          reason: bounded(outcome.reason, pipelineLimits.skipReason),
          at: this.timestamp(),
        },
      });
      return;
    }
    const parsed = stepResultSchema.safeParse(filteredResult(outcome.result));
    const result = parsed.success
      ? parsed.data
      : this.verdict(
          current,
          current.type === 'action' ? 'error' : 'fail',
          'The step returned a result that could not be saved.',
          current.startedAt ?? this.timestamp(),
          this.timestamp(),
        );
    this.writeStep(current, { state: VERDICT_STATES[result.status], result });
  }

  private awaitHuman(
    running: PipelineStepRecord,
    gate: Extract<StepOutcome, { kind: 'awaiting-human' }>,
  ): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const step = this.store.getStep(running.id);
      const run = this.store.getRun(running.runId);
      if (!step || step.state !== 'running') return;
      if (!run || run.status !== 'checking') {
        this.writeStep(step, { state: 'interrupted', result: null });
        return;
      }
      const now = this.timestamp();
      const waiting: PipelineStepRecord = {
        ...step,
        revision: step.revision + 1,
        state: 'awaiting-human',
        result: null,
        reviewId: gate.reviewId,
        reviewVersion: gate.reviewVersion,
        definitionChanges: gate.definitionChanges,
        updatedAt: now,
      };
      const paused: PipelineRun = {
        ...run,
        revision: run.revision + 1,
        status: 'awaiting-human',
        currentStepIndex: step.index,
        updatedAt: now,
      };
      if (!this.replaceBoth(waiting, step.revision, paused, run.revision))
        continue;
      this.emit({ type: 'pipeline-step-changed', step: waiting });
      this.emit({ type: 'pipeline-run-changed', run: paused });
      return;
    }
  }

  private replaceBoth(
    step: PipelineStepRecord,
    stepRevision: number,
    run: PipelineRun,
    runRevision: number,
  ): boolean {
    try {
      return this.store.transact(() => {
        if (!this.store.replaceStep(step, stepRevision)) return false;
        if (!this.store.replaceRun(run, runRevision))
          throw new Error('The run changed.');
        return true;
      });
    } catch {
      return false;
    }
  }

  private unmetNeed(definition: ResolvedStep): string | null {
    for (const need of definition.needs) {
      if (need === 'browser')
        return 'Browser steps are not available on this host';
      const name = need.slice('env:'.length);
      if (this.environment[name] == null || this.environment[name] === '')
        return `Environment variable ${name} is not set on this computer`;
    }
    return null;
  }

  private verdict(
    step: PipelineStepRecord,
    status: StepResult['status'],
    summary: string,
    startedAt: string,
    finishedAt: string,
  ): StepResult {
    return {
      name: step.name,
      type: step.type,
      phase: step.phase,
      status,
      summary: bounded(filterResultText(summary), 4000),
      evidence: [],
      outputs: {},
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      cost: { usd: null, inputTokens: null, outputTokens: null, provider: null },
      attempt: Math.max(step.attempt, 1),
    };
  }

  private writeRun(
    run: PipelineRun,
    changes: Partial<
      Pick<
        PipelineRun,
        'status' | 'attention' | 'finishedAt' | 'currentStepIndex'
      >
    >,
  ): boolean {
    const next: PipelineRun = {
      ...run,
      ...changes,
      revision: run.revision + 1,
      updatedAt: this.timestamp(),
    };
    if (!this.store.replaceRun(next, run.revision)) return false;
    this.emit({ type: 'pipeline-run-changed', run: next });
    return true;
  }

  private writeStep(
    step: PipelineStepRecord,
    changes: Partial<
      Pick<PipelineStepRecord, 'state' | 'result' | 'skip' | 'sessionId'>
    >,
  ): boolean {
    const next: PipelineStepRecord = {
      ...step,
      ...changes,
      revision: step.revision + 1,
      updatedAt: this.timestamp(),
    };
    if (!this.store.replaceStep(next, step.revision)) return false;
    this.emit({ type: 'pipeline-step-changed', step: next });
    return true;
  }

  private ensureIdle(directory: string): void {
    if (this.store.activeRunForDirectory(directory))
      throw new PipelineRunError(
        'busy',
        'A pipeline run is already active for this project. Stop it or wait until it ends.',
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

  private timestamp(): string {
    return this.clock.now().toISOString();
  }

  private track(promise: Promise<unknown>): void {
    const settled = promise.catch(() => undefined);
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }
}

const RESUMABLE_STEP_STATES: readonly PipelineStepState[] = [
  'interrupted',
  'failed',
  'error',
  'blocked',
];
const DEAD_TURN_STATES: readonly TurnState[] = [
  'failed',
  'stopped',
  'interrupted',
];

function resumeStatus(
  run: PipelineRun,
  latest: ReadonlyMap<number, PipelineStepRecord>,
  retrying: boolean,
  turn: (kind: 'plan' | 'implement') => TurnState,
): PipelineRunStatus {
  const begun = (phase: StepPhase) =>
    phaseIndices(run.pipeline, phase).some(index => latest.has(index));
  if (run.phase === 'pre-done' || run.phase === 'pre-push') return 'checking';
  if (!run.sessionId)
    return run.phase && begun(run.phase) ? 'checking' : 'pending';
  if (turn('implement') !== 'none') return 'implementing';
  if (run.phase === 'plan' && begun('plan'))
    return retrying ||
      phaseIndices(run.pipeline, 'plan').some(index => {
        const step = latest.get(index);
        return !step || !COMPLETE_STEP_STATES.includes(step.state);
      })
      ? 'checking'
      : 'implementing';
  if (turn('plan') !== 'none') return 'planning';
  return 'pending';
}

function earlierOutputs(
  steps: readonly PipelineStepRecord[],
  index: number,
): Map<string, Record<string, string>> {
  const outputs = new Map<string, Record<string, string>>();
  for (const step of [...latestAttempts(steps).values()].sort(
    (left, right) => left.index - right.index,
  ))
    if (step.index < index && step.result && Object.keys(step.result.outputs).length > 0)
      outputs.set(step.name, step.result.outputs);
  return outputs;
}

function filteredResult(result: StepResult): StepResult {
  return {
    ...result,
    summary: filterResultText(result.summary).slice(0, 4000),
    evidence: result.evidence.map(item => ({
      ...item,
      label: filterResultText(item.label).slice(0, 120),
      text: item.text === null ? null : filterResultText(item.text).slice(0, 4000),
    })),
    outputs: Object.fromEntries(
      Object.entries(result.outputs).map(([key, value]) => [
        key,
        filterResultText(value).slice(0, 4000),
      ]),
    ),
  };
}

function definitionFailure(error: unknown): PipelineRunError {
  if (!(error instanceof DefinitionError))
    return new PipelineRunError(
      'unavailable',
      'The task spec could not be read. Verify the folder and try again.',
    );
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
}
