import {
  pipelineLimits,
  type PipelineStepRecord,
  type Review,
  type StepResult,
} from '@nesvo/contracts';
import type { StepExecution, StepExecutor } from '../runner';

export const MANUAL_GATE_SKIP_REASON =
  'Runs without a task session do not wait for a human decision';
export const MANUAL_EXTERNAL_GATE_BLOCK =
  'A run without a task session cannot pass a human decision before an external step';
export const STALE_GATE_RESULT_BLOCK =
  'The latest result of this task was already decided outside its gate';

const DEFINITION_ROOTS = ['.agents/pipelines/', '.agents/tasks/'] as const;
const BINDABLE_REVIEWS: readonly Review['status'][] = ['pending', 'accepted'];

export type GateReviews = {
  latest: (sessionId: string) => Review | undefined;
};

export const definitionChanges = (review: Review | undefined): string[] =>
  (review?.diff.files ?? [])
    .map(file => file.path.replaceAll('\\', '/'))
    .filter(path =>
      DEFINITION_ROOTS.some(root =>
        path.replace(/^(\.\/)+/, '').toLowerCase().startsWith(root),
      ),
    )
    .slice(0, pipelineLimits.definitionChanges);

const precedesExternalStep = ({ run, step }: StepExecution) =>
  run.pipeline.steps.some(
    (other, index) =>
      index > step.index &&
      other.phase === step.phase &&
      other.effect === 'external',
  );

const blocked = (step: PipelineStepRecord, summary: string, at: string) => ({
  kind: 'result' as const,
  result: {
    name: step.name,
    type: step.type,
    phase: step.phase,
    status: 'blocked',
    summary,
    evidence: [],
    outputs: {},
    startedAt: step.startedAt ?? at,
    finishedAt: at,
    durationMs: Math.max(0, Date.parse(at) - Date.parse(step.startedAt ?? at)),
    cost: { usd: null, inputTokens: null, outputTokens: null, provider: null },
    attempt: Math.max(step.attempt, 1),
  } satisfies StepResult,
});

export const createHumanExecutor =
  (reviews: GateReviews): StepExecutor =>
  execution => {
    const { run, step, now } = execution;
    const at = now().toISOString();
    if (!run.sessionId)
      return Promise.resolve(
        precedesExternalStep(execution)
          ? blocked(step, MANUAL_EXTERNAL_GATE_BLOCK, at)
          : { kind: 'skipped', reason: MANUAL_GATE_SKIP_REASON },
      );
    const review = reviews.latest(run.sessionId);
    if (review && !BINDABLE_REVIEWS.includes(review.status))
      return Promise.resolve(blocked(step, STALE_GATE_RESULT_BLOCK, at));
    return Promise.resolve({
      kind: 'awaiting-human',
      reviewId: review?.id ?? null,
      reviewVersion: review?.version ?? null,
      definitionChanges: definitionChanges(review),
    });
  };
