import { useRef, useState } from 'react';
import type { PullRequestAction, PullRequestReference } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { PullRequestApi } from '@/entities/pull-request';

export type ActionState = {
  status: 'pending' | 'success' | 'error';
  message: string;
};

type UsePullRequestActionsParams = {
  api: PullRequestApi;
  reference: PullRequestReference;
  blockedReason: string;
};

type UsePullRequestActionsResult = {
  states: Record<string, ActionState>;
  run: (
    slot: string,
    action: PullRequestAction,
    successMessage: string,
  ) => Promise<boolean>;
  clear: (slot: string) => void;
};

export function usePullRequestActions({
  api,
  reference,
  blockedReason,
}: UsePullRequestActionsParams): UsePullRequestActionsResult {
  const [states, setStates] = useState<Record<string, ActionState>>({});
  const inFlight = useRef(new Set<string>());
  const update = (slot: string, state: ActionState) =>
    setStates(previous => ({ ...previous, [slot]: state }));
  const clear = (slot: string) =>
    setStates(previous => {
      if (!previous[slot] || previous[slot].status === 'pending')
        return previous;
      const next = { ...previous };
      delete next[slot];
      return next;
    });
  const run = async (
    slot: string,
    action: PullRequestAction,
    successMessage: string,
  ) => {
    if (blockedReason) {
      update(slot, { status: 'error', message: blockedReason });
      return false;
    }
    if (inFlight.current.has(slot)) return false;
    inFlight.current.add(slot);
    update(slot, { status: 'pending', message: '' });
    try {
      const result = await api.actOnPullRequest({
        actionId: crypto.randomUUID(),
        reference,
        action,
      });
      update(slot, {
        status: 'success',
        message: result.detail ?? successMessage,
      });
      return true;
    } catch (failure) {
      update(slot, { status: 'error', message: errorDetail(failure) });
      return false;
    } finally {
      inFlight.current.delete(slot);
    }
  };
  return { states, run, clear };
}
