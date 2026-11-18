import type { WorktreeRecipeRun, WorktreeRecipeStep } from '@nesvo/contracts';
import {
  recipeStepLabels,
  recipeStepStatusLabels,
} from '@/entities/worktree-recipe';
import { CodeBlock } from '@/shared/ui/code-block';
import { StatusDot } from '@/shared/ui/status-dot';

type RecipeStepsProps = {
  run: WorktreeRecipeRun;
  showOutput: boolean;
};

const stepTone = (status: WorktreeRecipeStep['status']) =>
  status === 'completed'
    ? 'success'
    : status === 'failed' || status === 'timed-out'
      ? 'error'
      : status === 'running'
        ? 'info'
        : 'neutral';

export function RecipeSteps({ run, showOutput }: RecipeStepsProps) {
  const visible = run.steps.filter(
    step => step.output && (showOutput || step.status === 'running'),
  );
  return (
    <div className="space-y-2">
      <ol aria-label="Recipe steps" className="space-y-1">
        {run.steps.map(step => (
          <li
            key={step.kind}
            className="flex min-w-0 items-center gap-2 text-xs leading-5"
          >
            <StatusDot
              tone={stepTone(step.status)}
              variant={step.status === 'running' ? 'spinner' : 'solid'}
            />
            <span className="min-w-0 truncate">
              {recipeStepLabels[step.kind]}
            </span>
            <span className="text-muted-foreground">
              {recipeStepStatusLabels[step.status]}
              {step.exitCode !== null && step.status !== 'completed'
                ? ` · exit code ${step.exitCode}`
                : ''}
            </span>
          </li>
        ))}
      </ol>
      {visible.map(step => (
        <CodeBlock
          key={step.kind}
          label={`${recipeStepLabels[step.kind]} output${step.truncated ? ' (last 64 KiB)' : ''}`}
          code={step.output}
          wrap
          maxHeightClassName="max-h-60"
        />
      ))}
    </div>
  );
}
