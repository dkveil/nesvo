import { useEffect, useState } from 'react';
import type { WorktreeRecipe, WorktreeRecipeRun } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { WorktreeRecipeApi } from '@/entities/worktree-recipe';
import { RecipeSteps } from '@/features/worktree-recipe';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { StatusMessage } from '@/shared/ui/status-message';

const TRIAL_POLL_MS = 1000;

type RecipeTrialDialogProps = {
  api: WorktreeRecipeApi;
  recipe: WorktreeRecipe;
  onOpenChange: (open: boolean) => void;
};

function trialStatus(trial: WorktreeRecipeRun | null, error: string) {
  if (error) return { tone: 'error' as const, text: error };
  if (!trial)
    return { tone: 'loading' as const, text: 'Creating a test worktree…' };
  if (!trial.released)
    return {
      tone: 'loading' as const,
      text:
        trial.status === 'running'
          ? 'Running the recipe in a throwaway worktree…'
          : 'Cleaning up the test worktree…',
    };
  if (trial.status === 'ready')
    return {
      tone: 'success' as const,
      text: 'The recipe ran successfully. The test worktree and its resources were removed.',
    };
  return {
    tone: 'error' as const,
    text:
      trial.error ??
      (trial.status === 'stopped'
        ? 'The test run was stopped.'
        : 'The recipe failed. Check the output below.'),
  };
}

export function RecipeTrialDialog({
  api,
  recipe,
  onOpenChange,
}: RecipeTrialDialogProps) {
  const [trial, setTrial] = useState<WorktreeRecipeRun | null>(null);
  const [error, setError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [tick, setTick] = useState(0);
  const directory = recipe.sourceDirectory;
  useEffect(() => {
    if (!directory) return;
    let active = true;
    void api.startWorktreeRecipeTrial({ id: recipe.id, directory }).then(
      next => {
        if (active) setTrial(next);
      },
      failure => {
        if (active) setError(errorDetail(failure));
      },
    );
    return () => {
      active = false;
    };
  }, [api, directory, recipe.id]);
  const running = !!trial && !trial.released;
  useEffect(() => {
    if (!running) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api.readWorktreeRecipeTrial({ id: recipe.id }).then(
        next => {
          if (!active) return;
          setTrial(next);
          setTick(value => value + 1);
        },
        failure => {
          if (active) setError(errorDetail(failure));
        },
      );
    }, TRIAL_POLL_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, recipe.id, running, tick]);
  const stop = () => {
    setStopping(true);
    void api
      .stopWorktreeRecipeTrial({ id: recipe.id })
      .then(setTrial, failure => setError(errorDetail(failure)))
      .finally(() => setStopping(false));
  };
  const status = trialStatus(
    trial,
    directory ? error : 'Save the recipe with a repository checkout first.',
  );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Test {recipe.name}</DialogTitle>
          <DialogDescription>
            Runs the copy, setup and cleanup steps in a throwaway worktree of{' '}
            {directory ?? recipe.repository.label} at its current commit, with
            its own ports, tag and temporary folder. Nothing is approved and no
            session is created.
          </DialogDescription>
        </DialogHeader>
        <StatusMessage tone={status.tone} variant="notice">
          {status.text}
        </StatusMessage>
        {trial && <RecipeSteps run={trial} showOutput />}
        <DialogFooter>
          {running && (
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={stopping || trial.status !== 'running'}
              onClick={stop}
            >
              {stopping ? 'Stopping…' : 'Stop test'}
            </Button>
          )}
          <DialogCancel onClick={() => onOpenChange(false)}>Close</DialogCancel>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
