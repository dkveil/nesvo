import { untilExecutor } from './steps/until';
import {
  ancestors,
  parseDurationMs,
  looksExternal,
  incoming,
  workflowLimits,
  stepResultSchema,
  type DefinitionCatalog,
  type GraphEdge,
  type DesktopEvent,
  type WorkflowRun,
  type WorkflowCiWait,
  type WorkflowRunStatus,
  type WorkflowStepRecord,
  type WorkflowStepState,
  type ResolvedWorkflow,
  type ResolvedStep,
  type RunWorkflowStepsInput,
  type StepPhase,
  type StepResult,
  type Evidence,
  type StepType,
} from '@nesvo/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import {
  DefinitionError,
  loadCatalog,
  loadSpec,
  resolveWorkflow,
  type LoadedSpec,
} from './definitions';
import { filterResultText, type EvidenceStore } from './evidence';
import type { WorkflowRunStore } from './store';

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
  turnState: (run: WorkflowRun, messageId: string) => TurnState;
  sendTurn: (
    turn: AuthorTurn,
  ) => 'sent' | 'busy' | 'unavailable' | { refusal: string };
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
): string => deterministicId(`workflow-turn:${runId}:${kind}:${attempt}`);

export const correctionMessageId = (
  runId: string,
  stepId: string,
  attempt: number,
): string =>
  deterministicId(`workflow-turn:${runId}:correction:${stepId}:${attempt}`);

export type StepExecution = {
  run: WorkflowRun;
  step: WorkflowStepRecord;
  definition: ResolvedStep;
  outputs: ReadonlyMap<string, Readonly<Record<string, string>>>;
  probeFindings?: readonly Evidence[];
  signal: AbortSignal;
  evidence: StepEvidence;
  environment: NodeJS.ProcessEnv;
  now: () => Date;
  link: (sessionId: string) => void;
  saveCiWait?: (checkpoint: WorkflowCiWait) => boolean;
};

export type StepEvidence = Pick<
  EvidenceStore,
  'write' | 'recordProcess' | 'clearProcess'
>;

export type StepOutcome =
  | { kind: 'result' | 'repeat'; result: StepResult }
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
  WorkflowRunStore,
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
  resolveWorkflow: (
    name: string,
    catalog: DefinitionCatalog,
  ) => ResolvedWorkflow;
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
  stepExecutors: Partial<Record<StepType, StepExecutor>>;
  author?: AuthorPort;
  environment?: NodeJS.ProcessEnv;
};

export class WorkflowRunError extends Error {
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
  resolveWorkflow,
};

const systemClock: RunnerClock = {
  now: () => new Date(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const TERMINAL_STATUSES: readonly WorkflowRunStatus[] = [
  'passed',
  'failed',
  'rejected',
  'stopped',
  'interrupted',
];
const WAITING_STATUSES: readonly WorkflowRunStatus[] = [
  'awaiting-human',
  'needs-attention',
  ...TERMINAL_STATUSES,
];
const AUTHOR_STATUSES: readonly WorkflowRunStatus[] = [
  'pending',
  'planning',
  'implementing',
  'fixing',
];
const ACTIVE_STEP_STATES: readonly WorkflowStepState[] = [
  'running',
  'awaiting-human',
  'uncertain',
];
const COMPLETE_STEP_STATES: readonly WorkflowStepState[] = [
  'passed',
  'done',
  'skipped',
];
const FAILED_STEP_STATES: readonly WorkflowStepState[] = ['failed', 'error'];
const SESSION_STEP_STATES: readonly WorkflowStepState[] = [
  'running',
  'awaiting-human',
];
const SERIAL_STEP_TYPES: readonly StepType[] = ['agent', 'human'];
const PARALLEL_STEP_LIMIT = 4;
const PHASE_RANK = {
  plan: 0,
  'pre-done': 1,
  'pre-push': 2,
} as const satisfies Record<StepPhase, number>;
const VERDICT_STATES = {
  pass: 'passed',
  fail: 'failed',
  blocked: 'blocked',
  done: 'done',
  error: 'error',
} as const satisfies Record<StepResult['status'], WorkflowStepState>;
const NEXT_PHASE = {
  plan: null,
  'pre-done': 'pre-push',
  'pre-push': null,
} as const satisfies Record<StepPhase, StepPhase | null>;

export type Move =
  | { kind: 'wait' }
  | { kind: 'begin-phase'; phase: StepPhase }
  | { kind: 'status'; status: WorkflowRunStatus }
  | { kind: 'attention'; message: string }
  | {
      kind: 'finish';
      status: 'passed' | 'failed' | 'stopped' | 'interrupted';
      message?: string;
    }
  | { kind: 'start-step'; step: WorkflowStepRecord }
  | { kind: 'mark-unreached'; step: WorkflowStepRecord; reason: string }
  | { kind: 'reopen-step'; step: WorkflowStepRecord }
  | { kind: 'send-turn'; turn: AuthorTurn };

export type MoveContext = {
  turnState: (messageId: string) => TurnState;
  hasAuthor: boolean;
  now?: number;
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
  steps: readonly WorkflowStepRecord[],
): Map<number, WorkflowStepRecord> {
  const latest = new Map<number, WorkflowStepRecord>();
  for (const step of steps) {
    const current = latest.get(step.index);
    if (!current || step.attempt >= current.attempt) latest.set(step.index, step);
  }
  return latest;
}

const phaseIndices = (workflow: ResolvedWorkflow, phase: StepPhase) =>
  workflow.steps.flatMap((step, index) => (step.phase === phase ? [index] : []));

const failureAttention = (step: WorkflowStepRecord) =>
  bounded(
    `Step "${step.name}" ${step.state === 'error' ? 'reported an error' : 'failed'}: ${step.result?.summary ?? 'no result was recorded.'}`,
    workflowLimits.attention,
  );

const needsPlanningTurn = (workflow: ResolvedWorkflow) =>
  workflow.steps.some(
    step =>
      step.phase === 'plan' && (step.type === 'agent' || step.type === 'human'),
  );

const afterImplementation = (run: WorkflowRun): Move => {
  for (const phase of ['pre-done', 'pre-push'] as const)
    if (phaseIndices(run.workflow, phase).length > 0)
      return { kind: 'begin-phase', phase };
  return { kind: 'finish', status: 'passed' };
};

const afterPlanning = (run: WorkflowRun): Move =>
  phaseIndices(run.workflow, 'plan').length > 0
    ? { kind: 'begin-phase', phase: 'plan' }
    : { kind: 'status', status: 'implementing' };

const authorTurn = (run: WorkflowRun, kind: 'plan' | 'implement'): AuthorTurn => ({
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
  run: WorkflowRun,
  steps: readonly WorkflowStepRecord[],
): { step: WorkflowStepRecord; comment: string } | null => {
  if (!run.phase) return null;
  const latest = latestAttempts(steps);
  for (const index of phaseIndices(run.workflow, run.phase)) {
    const step = latest.get(index);
    if (step?.state === 'failed' && step.decision?.kind === 'fix')
      return { step, comment: step.decision.comment };
  }
  return null;
};

const fixMove = (
  run: WorkflowRun,
  steps: readonly WorkflowStepRecord[],
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
  run: WorkflowRun,
  steps: readonly WorkflowStepRecord[],
  context: MoveContext,
): Move => {
  if (run.status === 'pending')
    return needsPlanningTurn(run.workflow)
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

const completedPhase = (run: WorkflowRun, context: MoveContext): Move => {
  if (!run.sessionId) return { kind: 'finish', status: 'passed' };
  if (!context.hasAuthor)
    return { kind: 'attention', message: NO_AUTHOR_ATTENTION };
  if (run.phase === 'plan') return { kind: 'status', status: 'implementing' };
  const next = run.phase ? NEXT_PHASE[run.phase] : null;
  return next && phaseIndices(run.workflow, next).length > 0
    ? { kind: 'begin-phase', phase: next }
    : { kind: 'finish', status: 'passed' };
};

type NodeOutcome = 'success' | 'failure' | 'unreached' | null;
type EdgeState = 'fired' | 'dead' | 'open';
type IncomingEdge = {
  edge: GraphEdge;
  outcome: NodeOutcome;
  state: EdgeState;
  order: number;
};

const outcomeOf = (step: WorkflowStepRecord | undefined): NodeOutcome => {
  if (!step) return null;
  if (COMPLETE_STEP_STATES.includes(step.state)) return 'success';
  if (FAILED_STEP_STATES.includes(step.state)) return 'failure';
  return step.state === 'unreached' ? 'unreached' : null;
};

const edgeState = (edge: GraphEdge, outcome: NodeOutcome): EdgeState => {
  if (!outcome) return 'open';
  if (outcome === 'unreached') return 'dead';
  return edge.when === 'any' || edge.when === outcome ? 'fired' : 'dead';
};

const unreachedReason = (source: string, outcome: NodeOutcome) =>
  bounded(
    `Not reached: "${source}" ${outcome === 'unreached' ? 'was not reached' : outcome === 'success' ? 'passed' : 'failed'}`,
    workflowLimits.skipReason,
  );

const isSerial = (step: WorkflowStepRecord) =>
  SERIAL_STEP_TYPES.includes(step.type);

const EXCLUSIVE_STEP_TYPES = {
  command: [],
  action: ['human'],
  agent: [],
  human: ['action'],
  'wait-ci': [],
  until: [],
  probe: [],
} as const satisfies Record<StepType, readonly StepType[]>;

const admits = (
  rows: readonly WorkflowStepRecord[],
  step: WorkflowStepRecord,
): boolean => {
  const excluded: readonly StepType[] = EXCLUSIVE_STEP_TYPES[step.type];
  if (
    rows.some(
      other =>
        excluded.includes(other.type) &&
        SESSION_STEP_STATES.includes(other.state),
    )
  )
    return false;
  return isSerial(step)
    ? !rows.some(
        other => isSerial(other) && SESSION_STEP_STATES.includes(other.state),
      )
    : rows.filter(other => !isSerial(other) && other.state === 'running')
        .length < PARALLEL_STEP_LIMIT;
};

const checkingMove = (
  run: WorkflowRun,
  phase: StepPhase,
  steps: readonly WorkflowStepRecord[],
  context: MoveContext,
): Move => {
  const latest = latestAttempts(steps);
  const rows: WorkflowStepRecord[] = [];
  for (const index of phaseIndices(run.workflow, phase)) {
    const step = latest.get(index);
    if (!step) return WAIT;
    rows.push(step);
  }
  if (
    !run.workflow.graph.explicit &&
    rows.some(step => ACTIVE_STEP_STATES.includes(step.state))
  )
    return WAIT;
  const blocked = rows.find(step => step.state === 'blocked');
  if (blocked)
    return {
      kind: 'attention',
      message: bounded(
        blocked.result?.summary || `Step "${blocked.name}" is blocked.`,
        workflowLimits.attention,
      ),
    };
  const all = [...latest.values()];
  const named = new Map(all.map(step => [step.name, step]));
  const edgesInto = (step: WorkflowStepRecord): IncomingEdge[] =>
    incoming(run.workflow.graph, step.name)
      .map(edge => {
        const source = named.get(edge.from);
        const outcome = outcomeOf(source);
        return {
          edge,
          outcome,
          state: edgeState(edge, outcome),
          order: source?.index ?? workflowLimits.stepsPerRun,
        };
      })
      .sort((left, right) => left.order - right.order);
  const halted =
    !run.workflow.graph.explicit &&
    rows.some(step => FAILED_STEP_STATES.includes(step.state));
  const pending = rows.filter(step => step.state === 'pending');
  const ready = halted
    ? []
    : pending.filter(
        step =>
          (!step.retryAt ||
            Date.parse(step.retryAt) <= (context.now ?? Date.now())) &&
          edgesInto(step).every(edge => edge.state === 'fired') &&
          ancestors(run.workflow.graph, step.name).every(name =>
            Boolean(outcomeOf(named.get(name))),
          ),
      );
  const start = ready.find(step => admits(all, step));
  if (start) return { kind: 'start-step', step: start };
  if (run.workflow.graph.explicit) {
    for (const step of pending) {
      const dead = edgesInto(step).find(edge => edge.state === 'dead');
      if (dead)
        return {
          kind: 'mark-unreached',
          step,
          reason: unreachedReason(dead.edge.from, dead.outcome),
        };
    }
    const reopened = rows.find(
      step =>
        step.state === 'unreached' &&
        edgesInto(step).every(edge => edge.state !== 'dead'),
    );
    if (reopened) return { kind: 'reopen-step', step: reopened };
  }
  if (
    ready.length > 0 ||
    pending.some(
      step =>
        step.retryAt && Date.parse(step.retryAt) > (context.now ?? Date.now()),
    ) ||
    rows.some(step => ACTIVE_STEP_STATES.includes(step.state))
  )
    return WAIT;
  const interrupted = rows.find(step => step.state === 'interrupted');
  if (interrupted)
    return {
      kind: 'attention',
      message: `Step "${interrupted.name}" was interrupted before it finished.`,
    };
  const failed = rows.find(step => FAILED_STEP_STATES.includes(step.state));
  if (failed)
    return run.workflow.steps[failed.index]?.on_fail === 'fix'
      ? { kind: 'attention', message: failureAttention(failed) }
      : { kind: 'finish', status: 'failed' };
  return completedPhase(run, context);
};

const runMove = (
  run: WorkflowRun,
  steps: readonly WorkflowStepRecord[],
  context: MoveContext,
): Move => {
  if (WAITING_STATUSES.includes(run.status)) return WAIT;
  if (run.sessionId && AUTHOR_STATUSES.includes(run.status))
    return context.hasAuthor
      ? authorMove(run, steps, context)
      : { kind: 'attention', message: NO_AUTHOR_ATTENTION };
  if (run.status === 'pending')
    return run.phase && phaseIndices(run.workflow, run.phase).length > 0
      ? { kind: 'begin-phase', phase: run.phase }
      : { kind: 'attention', message: 'The run has no steps to check.' };
  if (run.status !== 'checking' || !run.phase) return WAIT;
  return checkingMove(run, run.phase, steps, context);
};

export function nextMove(
  run: WorkflowRun,
  steps: readonly WorkflowStepRecord[],
  context: MoveContext,
): Move {
  const move = runMove(run, steps, context);
  return (move.kind === 'begin-phase' || move.kind === 'send-turn') &&
    [...latestAttempts(steps).values()].some(step => step.state === 'running')
    ? WAIT
    : move;
}

type PassState = { again: boolean; done: Promise<void> };
type BusyTurn = { timer: unknown; expired: boolean };
type ActiveStep = {
  runId: string;
  controller: AbortController;
  done: Promise<void>;
};

export class WorkflowRunner {
  private readonly store: RunnerStore;
  private readonly definitions: RunnerDefinitions;
  private readonly clock: RunnerClock;
  private readonly emit: (event: DesktopEvent) => void;
  private readonly evidence: RunnerPorts['evidence'];
  private readonly executors: RunnerPorts['stepExecutors'];
  private readonly author: AuthorPort | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly passes = new Map<string, PassState>();
  private readonly active = new Map<string, ActiveStep>();
  private readonly retryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
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
    input: RunWorkflowStepsInput,
    signal: AbortSignal,
  ): Promise<WorkflowRun> {
    const directory = this.resolveDirectory(input.directory);
    const phase = input.phase ?? 'pre-done';
    const specPath = isAbsolute(input.specPath)
      ? input.specPath
      : join(directory, input.specPath);
    this.ensureIdle(directory);
    let loaded: LoadedSpec;
    let workflow: ResolvedWorkflow;
    try {
      loaded = await this.definitions.loadSpec(specPath, directory, signal);
      workflow = this.definitions.resolveWorkflow(
        loaded.spec.workflow,
        await this.definitions.loadCatalog(directory, signal),
      );
    } catch (error) {
      throw definitionFailure(error);
    }
    if (phaseIndices(workflow, phase).length === 0)
      throw new WorkflowRunError(
        'invalid-request',
        `Workflow "${workflow.name}" has no steps in phase ${phase}.`,
      );
    if (this.closed)
      throw new WorkflowRunError('unavailable', 'The host is shutting down.');
    this.ensureIdle(directory);
    const now = this.timestamp();
    const run: WorkflowRun = {
      id: randomUUID(),
      revision: 1,
      workflow,
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
      throw new WorkflowRunError(
        'unavailable',
        'The run could not be saved. Try again.',
      );
    this.emit({ type: 'workflow-run-changed', run });
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

  stop(runId: string): WorkflowRun {
    for (let attempt = 0; attempt < 8; attempt++) {
      const run = this.store.getRun(runId);
      if (!run) throw new WorkflowRunError('not-found', 'Workflow run not found.');
      if (TERMINAL_STATUSES.includes(run.status)) return run;
      const now = this.timestamp();
      const stopped: WorkflowRun = {
        ...run,
        revision: run.revision + 1,
        status: 'stopped',
        updatedAt: now,
        finishedAt: now,
      };
      if (!this.store.replaceRun(stopped, run.revision)) continue;
      this.clearBusy(runId);
      this.emit({ type: 'workflow-run-changed', run: stopped });
      if (run.sessionId) this.author?.stop(runId);
      this.abortSteps(runId);
      this.track(this.advanceRun(runId));
      return stopped;
    }
    throw new WorkflowRunError(
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

  resume(runId: string): WorkflowRun {
    const run = this.store.getRun(runId);
    if (!run) throw new WorkflowRunError('not-found', 'Workflow run not found.');
    if (run.status !== 'interrupted' && run.status !== 'needs-attention')
      throw new WorkflowRunError(
        'invalid-request',
        'Only an interrupted run or a run that needs attention can be resumed.',
      );
    const latest = latestAttempts(this.store.stepsForRun(runId));
    const uncertain = [...latest.values()].find(
      step => step.state === 'uncertain',
    );
    if (uncertain)
      throw new WorkflowRunError(
        'invalid-request',
        `Step \`${uncertain.name}\` may already have run. Mark it done or run it again.`,
      );
    const active = this.store.activeRunForDirectory(run.projectRoot);
    if (active && active.id !== run.id)
      throw new WorkflowRunError(
        'busy',
        'A workflow run is already active for this project. Stop it or wait until it ends.',
      );
    if (this.closed)
      throw new WorkflowRunError('unavailable', 'The host is shutting down.');
    const turn = (kind: 'plan' | 'implement'): TurnState =>
      run.sessionId && this.author
        ? this.author.turnState(run, turnMessageId(run.id, kind, 1))
        : 'none';
    const correction = run.sessionId
      ? requestedCorrection(run, this.store.stepsForRun(runId))
      : null;
    const retried =
      run.phase && !correction
        ? phaseIndices(run.workflow, run.phase).flatMap(index => {
            const step = latest.get(index);
            return step && RESUMABLE_STEP_STATES.includes(step.state) ? [step] : [];
          })
        : [];
    const status = correction
      ? 'fixing'
      : resumeStatus(run, latest, retried.length > 0, turn);
    const awaited = correction
      ? 'correction'
      : status === 'planning'
        ? 'plan'
        : status === 'implementing'
          ? 'implement'
          : null;
    const awaitedState = correction
      ? this.author?.turnState(
          run,
          correctionMessageId(run.id, correction.step.id, correction.step.attempt),
        ) ?? 'none'
      : awaited && awaited !== 'correction'
        ? turn(awaited)
        : 'none';
    if (awaited && DEAD_TURN_STATES.includes(awaitedState))
      throw new WorkflowRunError(
        'invalid-request',
        `The ${TURN_LABELS[awaited]} turn did not finish, and a run never repeats a turn. Start a new task.`,
      );
    const now = this.timestamp();
    const next: WorkflowRun = {
      ...run,
      revision: run.revision + 1,
      status,
      attention: null,
      finishedAt: null,
      updatedAt: now,
    };
    const created = retried.map(step => nextAttempt(step, now));
    const written = this.store.transact(() => {
      if (!this.store.replaceRun(next, run.revision)) return false;
      for (const step of created)
        if (!this.store.insertStep(step)) throw new Error('Step row exists.');
      return true;
    });
    if (!written)
      throw new WorkflowRunError(
        'busy',
        'The run changed while it was being resumed. Try again.',
      );
    this.emit({ type: 'workflow-run-changed', run: next });
    for (const step of created) this.emit({ type: 'workflow-step-changed', step });
    this.track(this.advanceRun(runId));
    return next;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const runId of [...this.busy.keys()]) this.clearBusy(runId);
    for (const step of this.active.values()) step.controller.abort('shutdown');
    while (this.pending.size > 0 || this.active.size > 0)
      await Promise.all([
        ...this.pending,
        ...[...this.active.values()].map(step => step.done),
      ]);
  }

  private pass(runId: string): void {
    const limit = workflowLimits.stepsPerRun * 4 + 8;
    for (let iteration = 0; iteration < limit; iteration++) {
      const run = this.store.getRun(runId);
      if (!run) return;
      const timer = this.retryTimers.get(runId);
      if (timer) clearTimeout(timer);
      this.retryTimers.delete(runId);
      if (TERMINAL_STATUSES.includes(run.status)) this.abortSteps(runId);
      const steps = this.store.stepsForRun(runId);
      if (
        !TERMINAL_STATUSES.includes(run.status) &&
        run.status !== 'needs-attention'
      )
        for (const step of steps)
          if (
            step.type === 'wait-ci' &&
            step.state === 'running' &&
            !this.active.has(step.id)
          )
            this.executeStep(run, steps, step);
      const author = this.author;
      const move = nextMove(run, steps, {
        turnState: messageId =>
          run.sessionId && author ? author.turnState(run, messageId) : 'none',
        hasAuthor: Boolean(author),
        now: this.clock.now().getTime(),
      });
      if (this.closed) return;
      if (move.kind === 'wait') {
        if (run.status === 'checking') this.scheduleRetry(runId, steps);
        return;
      }
      if (!this.perform(run, steps, move)) return;
    }
  }

  private scheduleRetry(
    runId: string,
    steps: readonly WorkflowStepRecord[],
  ): void {
    const now = this.clock.now().getTime();
    const due = Math.min(
      ...[...latestAttempts(steps).values()].flatMap(step => {
        const time =
          step.state === 'pending' && step.retryAt
            ? Date.parse(step.retryAt)
            : 0;
        return time > now ? [time] : [];
      }),
    );
    if (!Number.isFinite(due)) return;
    this.retryTimers.set(
      runId,
      setTimeout(() => {
        this.retryTimers.delete(runId);
        this.track(this.advanceRun(runId));
      }, due - now),
    );
  }

  private perform(
    run: WorkflowRun,
    steps: readonly WorkflowStepRecord[],
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
    else if (move.kind === 'mark-unreached')
      this.writeStep(move.step, {
        state: 'unreached',
        result: null,
        skip: { reason: move.reason, at: this.timestamp() },
      });
    else if (move.kind === 'reopen-step') this.reopenStep(move.step);
    else this.startStep(run, steps, move.step);
    return true;
  }

  private abortSteps(runId: string): void {
    for (const step of this.active.values())
      if (step.runId === runId) step.controller.abort('stop');
  }

  private reopenStep(step: WorkflowStepRecord): void {
    const reopened = nextAttempt(step, this.timestamp());
    if (this.store.insertStep(reopened))
      this.emit({ type: 'workflow-step-changed', step: reopened });
  }

  private sendTurn(run: WorkflowRun, turn: AuthorTurn): boolean {
    const result = this.author!.sendTurn(turn);
    if (result === 'sent') {
      this.clearBusy(run.id);
      return true;
    }
    if (result === 'unavailable' || typeof result === 'object') {
      this.clearBusy(run.id);
      this.writeRun(run, {
        status: 'needs-attention',
        attention:
          typeof result === 'object'
            ? result.refusal
            : AUTHOR_UNAVAILABLE_ATTENTION,
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

  private beginPhase(run: WorkflowRun, phase: StepPhase): void {
    const now = this.timestamp();
    const indices = phaseIndices(run.workflow, phase);
    const next: WorkflowRun = {
      ...run,
      revision: run.revision + 1,
      status: 'checking',
      phase,
      currentStepIndex: indices[0] ?? null,
      attention: null,
      updatedAt: now,
    };
    const existing = latestAttempts(this.store.stepsForRun(run.id));
    const created: WorkflowStepRecord[] = [];
    const loopMembers = new Set(
      run.workflow.steps.flatMap(definition =>
        definition.type === 'until'
          ? [definition.name, ...(definition.repeat ?? [])]
          : [],
      ),
    );
    const written = this.store.transact(() => {
      if (!this.store.replaceRun(next, run.revision)) return false;
      for (const index of indices) {
        const definition = run.workflow.steps[index]!;
        const attempt = (existing.get(index)?.attempt ?? 0) + 1;
        const step: WorkflowStepRecord = {
          id: randomUUID(),
          runId: run.id,
          revision: 1,
          index,
          name: definition.name,
          type: definition.type,
          phase: definition.phase,
          state: 'pending',
          attempt,
          ...(loopMembers.has(definition.name) ? { iteration: 1 } : {}),
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
    this.emit({ type: 'workflow-run-changed', run: next });
    for (const step of created) this.emit({ type: 'workflow-step-changed', step });
  }

  private startStep(
    run: WorkflowRun,
    steps: readonly WorkflowStepRecord[],
    step: WorkflowStepRecord,
  ): void {
    const definition = run.workflow.steps[step.index];
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
    const currentIndex = Math.min(
      step.index,
      ...[...latestAttempts(steps).values()]
        .filter(other => SESSION_STEP_STATES.includes(other.state))
        .map(other => other.index),
    );
    if (run.currentStepIndex !== currentIndex)
      if (!this.writeRun(run, { currentStepIndex: currentIndex })) return;
    const running = this.store.beginStep(step.id, step.revision, this.timestamp());
    if (!running) return;
    this.emit({ type: 'workflow-step-changed', step: running });
    this.executeStep(run, steps, running);
  }

  private executeStep(
    run: WorkflowRun,
    steps: readonly WorkflowStepRecord[],
    running: WorkflowStepRecord,
  ): void {
    const definition = run.workflow.steps[running.index];
    if (!definition) return;
    const controller = new AbortController();
    const execution: StepExecution = {
      run: this.store.getRun(run.id) ?? run,
      step: running,
      definition,
      outputs: ancestorOutputs(run, steps, running),
      probeFindings:
        definition.type === 'agent'
          ? pendingProbeFindings(run, steps, running)
          : undefined,
      signal: controller.signal,
      evidence: this.evidence,
      environment: this.environment,
      now: () => this.clock.now(),
      link: sessionId => this.linkStep(running, sessionId),
      saveCiWait: ciWait => {
        const current = this.store.getStep(running.id);
        return (
          current?.state === 'running' && this.writeStep(current, { ciWait })
        );
      },
    };
    const executor =
      definition.type === 'until'
        ? untilExecutor
        : (this.executors[definition.type] ?? unavailableExecutor);
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
        if (!controller.signal.aborted) this.finishStep(running, outcome);
        else this.finishStep(running, { kind: 'interrupted' });
      })
      .finally(() => {
        this.active.delete(running.id);
        if (!this.closed) this.track(this.advanceRun(run.id));
      });
    this.active.set(running.id, { runId: run.id, controller, done });
  }

  private linkStep(running: WorkflowStepRecord, sessionId: string): void {
    const current = this.store.getStep(running.id);
    if (
      current &&
      current.state === 'running' &&
      current.attempt === running.attempt
    )
      this.writeStep(current, { sessionId });
  }

  private finishStep(running: WorkflowStepRecord, outcome: StepOutcome): void {
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
          reason: bounded(outcome.reason, workflowLimits.skipReason),
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
    const state = VERDICT_STATES[result.status];
    const run = this.store.getRun(current.runId);
    const definition = run?.workflow.steps[current.index];
    if (
      run &&
      parsed.success &&
      outcome.kind === 'repeat' &&
      definition?.type === 'until'
    ) {
      this.repeatSequence(run, current, definition.repeat ?? [], result);
      return;
    }
    const retry = current.retry ?? 0;
    if (
      (run?.status === 'checking' || run?.status === 'awaiting-human') &&
      definition &&
      retry < definition.retries &&
      FAILED_STEP_STATES.includes(state) &&
      mayRetry(run, definition)
    ) {
      const now = this.clock.now();
      const backoff = definition.retry_backoff
        ? (parseDurationMs(definition.retry_backoff) ?? 0)
        : 0;
      const next = {
        ...nextAttempt(current, now.toISOString()),
        retry: retry + 1,
        ...(backoff > 0
          ? { retryAt: new Date(now.getTime() + backoff).toISOString() }
          : {}),
      };
      this.finishAndQueue(current, state, result, [next]);
      return;
    }
    this.writeStep(current, { state, result });
  }

  private repeatSequence(
    run: WorkflowRun,
    control: WorkflowStepRecord,
    repeat: readonly string[],
    result: StepResult,
  ): void {
    const iteration = (control.iteration ?? 1) + 1;
    const latest = [...latestAttempts(this.store.stepsForRun(run.id)).values()];
    const names = new Set([...repeat, control.name]);
    const now = this.timestamp();
    const next = latest
      .filter(step => names.has(step.name))
      .map(step => ({
        ...nextAttempt(step, now),
        iteration,
      }));
    this.finishAndQueue(control, 'passed', result, next);
  }

  private finishAndQueue(
    current: WorkflowStepRecord,
    state: WorkflowStepState,
    result: StepResult,
    queued: readonly WorkflowStepRecord[],
  ): void {
    const finished = {
      ...current,
      state,
      result,
      revision: current.revision + 1,
      updatedAt: this.timestamp(),
    };
    const written = this.store.transact(() => {
      if (!this.store.replaceStep(finished, current.revision)) return false;
      for (const step of queued)
        if (!this.store.insertStep(step)) throw new Error('Step row exists.');
      return true;
    });
    if (written) {
      this.emit({ type: 'workflow-step-changed', step: finished });
      for (const step of queued)
        this.emit({ type: 'workflow-step-changed', step });
    }
  }

  private awaitHuman(
    running: WorkflowStepRecord,
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
      const waiting: WorkflowStepRecord = {
        ...step,
        revision: step.revision + 1,
        state: 'awaiting-human',
        result: null,
        reviewId: gate.reviewId,
        reviewVersion: gate.reviewVersion,
        definitionChanges: gate.definitionChanges,
        updatedAt: now,
      };
      const paused: WorkflowRun = {
        ...run,
        revision: run.revision + 1,
        status: 'awaiting-human',
        currentStepIndex: step.index,
        updatedAt: now,
      };
      if (!this.replaceBoth(waiting, step.revision, paused, run.revision))
        continue;
      this.emit({ type: 'workflow-step-changed', step: waiting });
      this.emit({ type: 'workflow-run-changed', run: paused });
      return;
    }
    const step = this.store.getStep(running.id);
    if (step?.state === 'running')
      this.writeStep(step, { state: 'interrupted', result: null });
  }

  private replaceBoth(
    step: WorkflowStepRecord,
    stepRevision: number,
    run: WorkflowRun,
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
    step: WorkflowStepRecord,
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
    run: WorkflowRun,
    changes: Partial<
      Pick<
        WorkflowRun,
        'status' | 'attention' | 'finishedAt' | 'currentStepIndex'
      >
    >,
  ): boolean {
    const next: WorkflowRun = {
      ...run,
      ...changes,
      revision: run.revision + 1,
      updatedAt: this.timestamp(),
    };
    if (!this.store.replaceRun(next, run.revision)) return false;
    this.emit({ type: 'workflow-run-changed', run: next });
    return true;
  }

  private writeStep(
    step: WorkflowStepRecord,
    changes: Partial<
      Pick<
        WorkflowStepRecord,
        'state' | 'result' | 'skip' | 'sessionId' | 'ciWait'
      >
    >,
  ): boolean {
    const next: WorkflowStepRecord = {
      ...step,
      ...changes,
      revision: step.revision + 1,
      updatedAt: this.timestamp(),
    };
    if (!this.store.replaceStep(next, step.revision)) return false;
    this.emit({ type: 'workflow-step-changed', step: next });
    return true;
  }

  private ensureIdle(directory: string): void {
    if (this.store.activeRunForDirectory(directory))
      throw new WorkflowRunError(
        'busy',
        'A workflow run is already active for this project. Stop it or wait until it ends.',
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

  private timestamp(): string {
    return this.clock.now().toISOString();
  }

  private track(promise: Promise<unknown>): void {
    const settled = promise.catch(() => undefined);
    this.pending.add(settled);
    void settled.finally(() => this.pending.delete(settled));
  }
}

const RESUMABLE_STEP_STATES: readonly WorkflowStepState[] = [
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
  run: WorkflowRun,
  latest: ReadonlyMap<number, WorkflowStepRecord>,
  retrying: boolean,
  turn: (kind: 'plan' | 'implement') => TurnState,
): WorkflowRunStatus {
  const begun = (phase: StepPhase) =>
    phaseIndices(run.workflow, phase).some(index => latest.has(index));
  if (run.phase === 'pre-done' || run.phase === 'pre-push') return 'checking';
  if (!run.sessionId)
    return run.phase && begun(run.phase) ? 'checking' : 'pending';
  if (turn('implement') !== 'none') return 'implementing';
  if (run.phase === 'plan' && begun('plan'))
    return retrying ||
      phaseIndices(run.workflow, 'plan').some(index => {
        const step = latest.get(index);
        return !step || !COMPLETE_STEP_STATES.includes(step.state);
      })
      ? 'checking'
      : 'implementing';
  if (turn('plan') !== 'none') return 'planning';
  return 'pending';
}

function nextAttempt(step: WorkflowStepRecord, now: string): WorkflowStepRecord {
  return {
    ...step,
    retry: undefined,
    retryAt: undefined,
    ciWait: undefined,
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
  };
}

function mayRetry(run: WorkflowRun, step: ResolvedStep): boolean {
  if (step.type === 'human') return false;
  if (step.idempotent || step.type === 'wait-ci' || step.type === 'probe')
    return true;
  if (
    step.type !== 'command' ||
    step.effect === 'external' ||
    looksExternal(step.body)
  )
    return false;
  const before = new Set(ancestors(run.workflow.graph, step.name));
  return !run.workflow.steps.some(
    other =>
      other.type === 'human' &&
      (before.has(other.name) ||
        PHASE_RANK[other.phase] < PHASE_RANK[step.phase]),
  );
}

function precedingSteps(
  run: WorkflowRun,
  steps: readonly WorkflowStepRecord[],
  step: WorkflowStepRecord,
) {
  const visible = new Set(ancestors(run.workflow.graph, step.name));
  return [...latestAttempts(steps).values()].filter(
    other =>
      visible.has(other.name) ||
      PHASE_RANK[other.phase] < PHASE_RANK[step.phase],
  );
}

function pendingProbeFindings(
  run: WorkflowRun,
  steps: readonly WorkflowStepRecord[],
  step: WorkflowStepRecord,
): Evidence[] {
  const preceding = precedingSteps(run, steps, step);
  const addressed = new Set(
    preceding
      .filter(other => other.type === 'agent')
      .flatMap(other => other.result?.evidence.map(item => item.label) ?? []),
  );
  const pending = preceding
    .filter(other => other.type === 'probe')
    .flatMap(
      other =>
        other.result?.evidence.filter(item => !addressed.has(item.label)) ?? [],
    );
  if (pending.length <= 24) return pending;
  return [
    ...pending.slice(0, 23),
    {
      kind: 'text',
      label: `probe/${step.id}/overflow`,
      path: null,
      url: null,
      text: `${pending.length - 23} additional findings are listed on the upstream probe steps. Review the remaining changed files for the same categories of findings and give a disposition.`,
    },
  ];
}

function ancestorOutputs(
  run: WorkflowRun,
  steps: readonly WorkflowStepRecord[],
  step: WorkflowStepRecord,
): Map<string, Record<string, string>> {
  const outputs = new Map<string, Record<string, string>>();
  for (const other of precedingSteps(run, steps, step).sort(
    (left, right) => left.index - right.index,
  ))
    if (other.result && Object.keys(other.result.outputs).length > 0)
      outputs.set(other.name, other.result.outputs);
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

function definitionFailure(error: unknown): WorkflowRunError {
  if (!(error instanceof DefinitionError))
    return new WorkflowRunError(
      'unavailable',
      'The task spec could not be read. Verify the folder and try again.',
    );
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
}
