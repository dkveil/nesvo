import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DecideSessionWorktreeRecipeInput,
  WorktreeRecipeRun,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { SessionWorktreeRecipeApi } from '@/entities/worktree-recipe';

const RUNNING_POLL_MS = 1000;
const WAITING_POLL_MS = 5000;

type SessionRecipeState = {
  key: string;
  run: WorktreeRecipeRun | null;
  error: string;
};

export type SessionWorktreeRecipe = {
  run: WorktreeRecipeRun | null;
  error: string;
  pending: boolean;
  decide: (decision: DecideSessionWorktreeRecipeInput['decision']) => void;
};

export function useSessionWorktreeRecipe(
  api: SessionWorktreeRecipeApi | undefined,
  sessionId: string | undefined,
  refreshKey: string,
): SessionWorktreeRecipe {
  const key = sessionId ?? '';
  const [state, setState] = useState<SessionRecipeState>({
    key,
    run: null,
    error: '',
  });
  const [pending, setPending] = useState(false);
  const [tick, setTick] = useState(0);
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
  }, [key]);
  const run = state.key === key ? state.run : null;
  const status = run && !run.released ? run.status : null;

  useEffect(() => {
    if (!api || !sessionId) return;
    let active = true;
    void api.readSessionWorktreeRecipe({ sessionId }).then(
      next => {
        if (active) setState({ key: sessionId, run: next, error: '' });
      },
      failure => {
        if (active)
          setState(previous => ({
            key: sessionId,
            run: previous.key === sessionId ? previous.run : null,
            error: errorDetail(failure),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [api, sessionId, refreshKey, tick]);

  useEffect(() => {
    if (status !== 'running' && status !== 'needs-approval') return;
    const timer = window.setTimeout(
      () => setTick(value => value + 1),
      status === 'running' ? RUNNING_POLL_MS : WAITING_POLL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status, tick]);

  const decide = useCallback(
    (decision: DecideSessionWorktreeRecipeInput['decision']) => {
      if (!api || !sessionId || !run || pending) return;
      setPending(true);
      void api
        .decideSessionWorktreeRecipe({
          sessionId,
          decision,
          sha256: run.recipe.sha256,
        })
        .then(
          next => {
            if (current.current === sessionId)
              setState({ key: sessionId, run: next, error: '' });
          },
          failure => {
            if (current.current === sessionId)
              setState(previous => ({
                ...previous,
                error: errorDetail(failure),
              }));
          },
        )
        .finally(() => setPending(false));
    },
    [api, pending, run, sessionId],
  );

  return {
    run,
    error: state.key === key ? state.error : '',
    pending,
    decide,
  };
}
