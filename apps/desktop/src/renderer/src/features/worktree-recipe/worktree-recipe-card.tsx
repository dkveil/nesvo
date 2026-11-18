import { useState } from 'react';
import type { WorktreeRecipeRun } from '@nesvo/contracts';
import { recipeRunStatusLabels } from '@/entities/worktree-recipe';
import { Button } from '@/shared/ui/button';
import { StatusMessage, type StatusTone } from '@/shared/ui/status-message';
import { RecipeContents } from './recipe-contents';
import { RecipeSteps } from './recipe-steps';
import type { SessionWorktreeRecipe } from './use-session-worktree-recipe';

type WorktreeRecipeCardProps = SessionWorktreeRecipe & {
  run: WorktreeRecipeRun;
  enabled: boolean;
};

const runTone = (run: WorktreeRecipeRun): StatusTone =>
  run.status === 'running'
    ? 'loading'
    : run.status === 'ready'
      ? 'success'
      : run.status === 'failed'
        ? 'error'
        : run.status === 'stopped' || run.status === 'interrupted'
          ? 'warning'
          : 'info';

function ApprovalCard({
  run,
  enabled,
  pending,
  error,
  decide,
}: WorktreeRecipeCardProps) {
  return (
    <section
      aria-label="Worktree recipe approval"
      className="space-y-3 rounded-surface border bg-card p-4"
    >
      <p className="text-2xs text-muted-foreground">Worktree recipe</p>
      <h2 className="text-sm font-medium [overflow-wrap:anywhere]">
        Prepare this worktree with {run.recipe.name}?
      </h2>
      <p className="text-xs leading-5 text-muted-foreground">
        Commands run on this computer with the host account’s permissions.
        Approval covers this exact version for this repository checkout; any
        change asks again. Queued messages wait until the recipe finishes or you
        skip it.
      </p>
      <RecipeContents
        recipe={run.recipe}
        repositoryScript={run.repositoryScript}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={!enabled || pending}
          onClick={() => decide('approve')}
        >
          Approve and run
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!enabled || pending}
          onClick={() => decide('skip')}
        >
          Skip recipe
        </Button>
      </div>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </section>
  );
}

export function WorktreeRecipeCard(props: WorktreeRecipeCardProps) {
  const { run, enabled, pending, error, decide } = props;
  const [showOutput, setShowOutput] = useState(false);
  if (run.status === 'needs-approval' && !run.released)
    return <ApprovalCard {...props} />;
  const retry =
    !run.released &&
    (run.status === 'failed' ||
      run.status === 'stopped' ||
      run.status === 'interrupted');
  const ports = run.resources?.ports ?? [];
  return (
    <section
      aria-label="Worktree recipe"
      className="space-y-2 rounded-surface border bg-card px-3 py-2.5"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <StatusMessage tone={runTone(run)} className="min-w-0 flex-1 text-xs">
          {recipeRunStatusLabels[run.status]} · {run.recipe.name}
          {ports.length > 0 && !run.released && (
            <span className="font-mono text-muted-foreground">
              {' '}
              {ports.map(port => `:${port}`).join(' ')}
            </span>
          )}
          {run.released && (
            <span className="text-muted-foreground"> · resources released</span>
          )}
        </StatusMessage>
        <div className="flex shrink-0 items-center gap-1">
          {run.status === 'running' && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!enabled || pending}
              onClick={() => decide('stop')}
            >
              Stop setup
            </Button>
          )}
          {retry && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!enabled || pending}
              onClick={() => decide('approve')}
            >
              Run again
            </Button>
          )}
          {run.steps.length > 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={showOutput}
              onClick={() => setShowOutput(value => !value)}
            >
              {showOutput ? 'Hide details' : 'Details'}
            </Button>
          )}
        </div>
      </div>
      {(showOutput || run.status === 'running') && (
        <RecipeSteps run={run} showOutput={showOutput} />
      )}
      {run.error && (
        <StatusMessage tone="error" className="whitespace-pre-wrap">
          {run.error}
        </StatusMessage>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </section>
  );
}
