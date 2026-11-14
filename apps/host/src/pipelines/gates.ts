import {
  pipelineLimits,
  stepResultLimits,
  stepResultSchema,
  type DecidePipelineGateInput,
  type DesktopEvent,
  type PipelineRun,
  type PipelineRunStatus,
  type PipelineStepDecision,
  type PipelineStepRecord,
  type PipelineStepState,
  type ResolvePipelineStepInput,
  type SkipPipelineStepInput,
  type StepPhase,
  type StepResult,
} from '@nesvo/contracts';
import { randomUUID } from 'node:crypto';
import type { GateReviewDecision } from '../sessions/service';
import { filterResultText } from './evidence';
import { PipelineRunError, latestAttempts, type PipelineRunner } from './runner';
import type { PipelineRunStore } from './store';

export const MARKED_DONE_SUMMARY =
  'Marked done by the operator. Later steps receive no outputs from it.';

type GateStore = Pick<
  PipelineRunStore,
  | 'transact'
  | 'getRun'
  | 'replaceRun'
  | 'getStep'
  | 'replaceStep'
  | 'insertStep'
  | 'stepsForRun'
  | 'stepByDecision'
  | 'activeRunForDirectory'
>;

type GateDecision = Required<DecidePipelineGateInput>;
type StepResolution = Required<ResolvePipelineStepInput>;

export type GatePorts = {
  store: GateStore;
  runner: Pick<PipelineRunner, 'advanceRun'>;
  reviews: {
    decide: (input: GateReviewDecision, record: () => void) => Promise<unknown>;
  };
  emit: (event: DesktopEvent) => void;
};

const PHASE_ORDER: readonly StepPhase[] = ['plan', 'pre-done', 'pre-push'];
const SKIPPABLE_STATES: readonly PipelineStepState[] = [
  'pending',
  'awaiting-human',
  'failed',
  'error',
  'blocked',
];
const SKIPPABLE_RUNS: readonly PipelineRunStatus[] = [
  'checking',
  'awaiting-human',
  'needs-attention',
];
const GATE_OUTCOMES = {
  accept: {
    status: 'pass',
    state: 'passed',
    run: 'checking',
    summary: 'Accepted by the operator',
  },
  reject: {
    status: 'fail',
    state: 'failed',
    run: 'rejected',
    summary: 'Rejected by the operator',
  },
  fix: {
    status: 'fail',
    state: 'failed',
    run: 'fixing',
    summary: 'Sent back to fix by the operator',
  },
} as const satisfies Record<
  GateDecision['decision'],
  {
    status: StepResult['status'];
    state: PipelineStepState;
    run: PipelineRunStatus;
    summary: string;
  }
>;
const REVIEW_DECISIONS = {
  accept: 'accept',
  reject: 'reject',
  fix: 'request-changes',
} as const satisfies Record<
  GateDecision['decision'],
  GateReviewDecision['decision']
>;

const invalid = (message: string) =>
  new PipelineRunError('invalid-request', message);

const changed = () =>
  new PipelineRunError(
    'busy',
    'The run changed while the decision was being saved. Refresh and try again.',
  );

const uncertainRefusal = (step: PipelineStepRecord) =>
  invalid(
    `Step \`${step.name}\` may already have run. Mark it done or run it again.`,
  );

const bounded = (value: string, limit: number) =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

const position = (run: PipelineRun, index: number): [number, number] => [
  PHASE_ORDER.indexOf(run.pipeline.steps[index]?.phase ?? 'plan'),
  index,
];

const before = (left: [number, number], right: [number, number]) =>
  left[0] < right[0] || (left[0] === right[0] && left[1] < right[1]);

const guardsExternalStep = (
  run: PipelineRun,
  latest: ReadonlyMap<number, PipelineStepRecord>,
  gate: PipelineStepRecord,
): boolean =>
  run.pipeline.steps.some(
    (external, index) =>
      external.effect === 'external' &&
      before(position(run, gate.index), position(run, index)) &&
      !run.pipeline.steps.some(
        (other, otherIndex) =>
          otherIndex !== gate.index &&
          other.type === 'human' &&
          before(position(run, otherIndex), position(run, index)) &&
          latest.get(otherIndex)?.state !== 'skipped',
      ),
  );

export class PipelineGates {
  private readonly deciding = new Map<
    string,
    { input: GateDecision; result: Promise<PipelineRun> }
  >();

  constructor(private readonly ports: GatePorts) {}

  decide(input: GateDecision): Promise<PipelineRun> {
    const inflight = this.deciding.get(input.decisionId);
    if (inflight) {
      if (!sameGateDecision(inflight.input, input))
        return Promise.reject(invalid('This decision ID is already in use.'));
      return inflight.result;
    }
    const result = this.record(input).finally(() =>
      this.deciding.delete(input.decisionId),
    );
    this.deciding.set(input.decisionId, { input, result });
    return result;
  }

  skip(input: SkipPipelineStepInput): PipelineRun {
    const { run, step, latest } = this.target(input.runId, input.stepId);
    const uncertain = [...latest.values()].find(
      item => item.state === 'uncertain',
    );
    if (uncertain) throw uncertainRefusal(uncertain);
    if (!SKIPPABLE_STATES.includes(step.state))
      throw invalid(
        'Only a pending, waiting, failed or blocked step can be skipped.',
      );
    if (step.phase !== run.phase || !SKIPPABLE_RUNS.includes(run.status))
      throw invalid(
        'Only a step in the phase the run is checking can be skipped.',
      );
    this.ensureOnlyActiveRun(run);
    if (step.type === 'human' && guardsExternalStep(run, latest, step))
      throw invalid(
        `Step "${step.name}" is the human decision before an external step and cannot be skipped.`,
      );
    const now = new Date().toISOString();
    const waiting = [...latest.values()].some(
      item => item.id !== step.id && item.state === 'awaiting-human',
    );
    const skipped: PipelineStepRecord = {
      ...step,
      revision: step.revision + 1,
      state: 'skipped',
      result: null,
      skip: { reason: bounded(input.reason, pipelineLimits.skipReason), at: now },
      updatedAt: now,
    };
    const next: PipelineRun = {
      ...run,
      revision: run.revision + 1,
      status: waiting ? 'awaiting-human' : 'checking',
      attention: null,
      updatedAt: now,
    };
    this.ports.store.transact(() => this.replace(step, skipped, run, next));
    return this.advance(next, [skipped]);
  }

  resolve(input: StepResolution): PipelineRun {
    const recorded = this.ports.store.stepByDecision(input.decisionId);
    if (recorded) {
      if (
        recorded.runId !== input.runId ||
        recorded.id !== input.stepId ||
        recorded.decision?.kind !== input.resolution ||
        recorded.decision.comment !== input.comment
      )
        throw invalid('This decision ID is already in use.');
      return this.currentRun(input.runId);
    }
    const { run, step } = this.target(input.runId, input.stepId);
    if (step.state !== 'uncertain')
      throw invalid(
        'Only a step that may already have run can be marked done or run again.',
      );
    if (run.status !== 'needs-attention')
      throw invalid('This run is not waiting for the step to be resolved.');
    this.ensureOnlyActiveRun(run);
    const now = new Date().toISOString();
    const decision: PipelineStepDecision = {
      decisionId: input.decisionId,
      kind: input.resolution,
      comment: input.comment,
      at: now,
    };
    const resolved: PipelineStepRecord = {
      ...step,
      revision: step.revision + 1,
      decision,
      updatedAt: now,
      ...(input.resolution === 'mark-done'
        ? {
            state: 'done' as const,
            result: operatorResult(step, {
              status: 'done',
              summary: MARKED_DONE_SUMMARY,
              note: input.comment,
              at: now,
            }),
          }
        : {}),
    };
    const retry: PipelineStepRecord[] =
      input.resolution === 'run-again'
        ? [
            {
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
            },
          ]
        : [];
    const next: PipelineRun = {
      ...run,
      revision: run.revision + 1,
      status: 'checking',
      attention: null,
      updatedAt: now,
    };
    this.ports.store.transact(() => {
      this.replace(step, resolved, run, next);
      for (const item of retry)
        if (!this.ports.store.insertStep(item)) throw changed();
    });
    return this.advance(next, [resolved, ...retry]);
  }

  private async record(input: GateDecision): Promise<PipelineRun> {
    const recorded = this.ports.store.stepByDecision(input.decisionId);
    if (recorded) {
      if (
        recorded.runId !== input.runId ||
        recorded.id !== input.stepId ||
        recorded.reviewId !== input.reviewId ||
        recorded.reviewVersion !== input.version ||
        recorded.decision?.kind !== input.decision ||
        recorded.decision.comment !== input.comment
      )
        throw invalid('This decision ID is already in use.');
      return this.currentRun(input.runId);
    }
    const { run, step } = this.target(input.runId, input.stepId);
    if (
      step.type !== 'human' ||
      step.state !== 'awaiting-human' ||
      run.status !== 'awaiting-human'
    )
      throw invalid('This gate is not waiting for a decision. Refresh the run.');
    if (step.reviewId !== input.reviewId)
      throw invalid('This gate is bound to a different result. Refresh the run.');
    if (step.reviewVersion !== input.version)
      throw invalid(
        'This result version is no longer current. Refresh the run.',
      );
    if (input.decision === 'fix' && !run.sessionId)
      throw invalid('This run has no task session to correct.');
    const now = new Date().toISOString();
    const outcome = GATE_OUTCOMES[input.decision];
    const decided: PipelineStepRecord = {
      ...step,
      revision: step.revision + 1,
      state: outcome.state,
      result: operatorResult(step, {
        status: outcome.status,
        summary: outcome.summary,
        note: input.comment || 'Accepted',
        at: now,
      }),
      decision: {
        decisionId: input.decisionId,
        kind: input.decision,
        comment: input.comment,
        at: now,
      },
      updatedAt: now,
    };
    const next: PipelineRun = {
      ...run,
      revision: run.revision + 1,
      status: outcome.run,
      attention: null,
      finishedAt: input.decision === 'reject' ? now : null,
      updatedAt: now,
    };
    const write = () => this.replace(step, decided, run, next);
    if (step.reviewId && step.reviewVersion)
      await this.ports.reviews.decide(
        {
          reviewId: step.reviewId,
          version: step.reviewVersion,
          decisionId: input.decisionId,
          decision: REVIEW_DECISIONS[input.decision],
          feedback: input.comment,
        },
        write,
      );
    else this.ports.store.transact(write);
    return this.advance(next, [decided]);
  }

  private target(
    runId: string,
    stepId: string,
  ): {
    run: PipelineRun;
    step: PipelineStepRecord;
    latest: Map<number, PipelineStepRecord>;
  } {
    const run = this.ports.store.getRun(runId);
    if (!run) throw new PipelineRunError('not-found', 'Pipeline run not found.');
    const step = this.ports.store.getStep(stepId);
    if (!step || step.runId !== run.id)
      throw new PipelineRunError('not-found', 'Pipeline step not found.');
    const latest = latestAttempts(this.ports.store.stepsForRun(run.id));
    if (latest.get(step.index)?.id !== step.id)
      throw invalid('This step has a newer attempt. Refresh the run.');
    return { run, step, latest };
  }

  private replace(
    step: PipelineStepRecord,
    nextStep: PipelineStepRecord,
    run: PipelineRun,
    nextRun: PipelineRun,
  ): void {
    if (
      !this.ports.store.replaceStep(nextStep, step.revision) ||
      !this.ports.store.replaceRun(nextRun, run.revision)
    )
      throw changed();
  }

  private advance(run: PipelineRun, steps: PipelineStepRecord[]): PipelineRun {
    for (const step of steps)
      this.ports.emit({ type: 'pipeline-step-changed', step });
    this.ports.emit({ type: 'pipeline-run-changed', run });
    void this.ports.runner.advanceRun(run.id).catch(() => undefined);
    return run;
  }

  private ensureOnlyActiveRun(run: PipelineRun): void {
    const active = this.ports.store.activeRunForDirectory(run.projectRoot);
    if (active && active.id !== run.id)
      throw new PipelineRunError(
        'busy',
        'A pipeline run is already active for this project. Stop it or wait until it ends.',
      );
  }

  private currentRun(runId: string): PipelineRun {
    const run = this.ports.store.getRun(runId);
    if (!run) throw new PipelineRunError('not-found', 'Pipeline run not found.');
    return run;
  }
}

const sameGateDecision = (left: GateDecision, right: GateDecision) =>
  left.runId === right.runId &&
  left.stepId === right.stepId &&
  left.reviewId === right.reviewId &&
  left.version === right.version &&
  left.decision === right.decision &&
  left.comment === right.comment;

const operatorResult = (
  step: PipelineStepRecord,
  {
    status,
    summary,
    note,
    at,
  }: { status: StepResult['status']; summary: string; note: string; at: string },
): StepResult => {
  const startedAt = step.startedAt ?? at;
  return stepResultSchema.parse({
    name: step.name,
    type: step.type,
    phase: step.phase,
    status,
    summary,
    evidence: [
      {
        kind: 'text',
        label: 'Operator note',
        path: null,
        text: bounded(filterResultText(note), stepResultLimits.evidenceText),
        url: null,
      },
    ],
    outputs: {},
    startedAt,
    finishedAt: at,
    durationMs: Math.max(0, Date.parse(at) - Date.parse(startedAt)),
    cost: { usd: null, inputTokens: null, outputTokens: null, provider: null },
    attempt: Math.max(step.attempt, 1),
  });
};
