import { pipelineLimits, type Review } from '@nesvo/contracts';
import type { StepExecutor } from '../runner';

export const MANUAL_GATE_SKIP_REASON =
  'Runs without a task session do not wait for a human decision';

const DEFINITION_ROOTS = ['.agents/pipelines/', '.agents/tasks/'] as const;

export type GateReviews = {
  latest: (sessionId: string) => Review | undefined;
};

export const definitionChanges = (review: Review | undefined): string[] =>
  (review?.diff.files ?? [])
    .map(file => file.path.replaceAll('\\', '/'))
    .filter(path => DEFINITION_ROOTS.some(root => path.startsWith(root)))
    .slice(0, pipelineLimits.definitionChanges);

export const createHumanExecutor =
  (reviews: GateReviews): StepExecutor =>
  ({ run }) => {
    if (!run.sessionId)
      return Promise.resolve({
        kind: 'skipped',
        reason: MANUAL_GATE_SKIP_REASON,
      });
    const review = reviews.latest(run.sessionId);
    return Promise.resolve({
      kind: 'awaiting-human',
      reviewId: review?.id ?? null,
      reviewVersion: review?.version ?? null,
      definitionChanges: definitionChanges(review),
    });
  };
