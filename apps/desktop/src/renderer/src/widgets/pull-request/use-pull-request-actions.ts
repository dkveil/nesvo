import { useRef, useState } from 'react';
import type { PullRequestAction, PullRequestReference } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { PullRequestApi } from '@/entities/pull-request';
import { isOutcomeUnknown, OUTCOME_UNKNOWN_MESSAGE } from './outcome';

export type ActionState =
  | { status: 'pending' | 'success' | 'error'; message: string }
  | {
      status: 'unknown';
      message: string;
      retry: () => void;
      discard: () => void;
      refresh: () => void;
    };

export function isActionLocked(state: ActionState | undefined) {
  return state?.status === 'pending' || state?.status === 'unknown';
}

type Submission = {
  actionId: string;
  action: PullRequestAction;
  successMessage: string;
  settle: (done: boolean) => void;
};

type UsePullRequestActionsParams = {
  api: PullRequestApi;
  reference: PullRequestReference;
  blockedReason: string;
  onRefresh: () => void;
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
  onRefresh,
}: UsePullRequestActionsParams): UsePullRequestActionsResult {
  const [states, setStates] = useState<Record<string, ActionState>>({});
  const inFlight = useRef(new Set<string>());
  const submissions = useRef(new Map<string, Submission>());
  const update = (slot: string, state: ActionState) =>
    setStates(previous => ({ ...previous, [slot]: state }));
  const remove = (slot: string) =>
    setStates(previous => {
      const next = { ...previous };
      delete next[slot];
      return next;
    });
  const clear = (slot: string) =>
    setStates(previous => {
      if (!previous[slot] || isActionLocked(previous[slot])) return previous;
      const next = { ...previous };
      delete next[slot];
      return next;
    });
  const send = async (slot: string, submission: Submission) => {
    if (inFlight.current.has(slot)) return;
    inFlight.current.add(slot);
    update(slot, { status: 'pending', message: '' });
    try {
      const result = await api.actOnPullRequest({
        actionId: submission.actionId,
        reference,
        action: submission.action,
      });
      submissions.current.delete(slot);
      update(slot, {
        status: 'success',
        message: result.detail ?? submission.successMessage,
      });
      submission.settle(true);
    } catch (failure) {
      if (isOutcomeUnknown(failure)) {
        update(slot, {
          status: 'unknown',
          message: OUTCOME_UNKNOWN_MESSAGE,
          retry: () => void send(slot, submission),
          discard: () => discard(slot),
          refresh: onRefresh,
        });
        return;
      }
      submissions.current.delete(slot);
      update(slot, { status: 'error', message: errorDetail(failure) });
      submission.settle(false);
    } finally {
      inFlight.current.delete(slot);
    }
  };
  const discard = (slot: string) => {
    const submission = submissions.current.get(slot);
    if (!submission || inFlight.current.has(slot)) return;
    submissions.current.delete(slot);
    remove(slot);
    submission.settle(false);
  };
  const run = (
    slot: string,
    action: PullRequestAction,
    successMessage: string,
  ) => {
    if (blockedReason) {
      update(slot, { status: 'error', message: blockedReason });
      return Promise.resolve(false);
    }
    if (submissions.current.has(slot)) return Promise.resolve(false);
    return new Promise<boolean>(settle => {
      const submission = {
        actionId: crypto.randomUUID(),
        action,
        successMessage,
        settle,
      };
      submissions.current.set(slot, submission);
      void send(slot, submission);
    });
  };
  return { states, run, clear };
}
