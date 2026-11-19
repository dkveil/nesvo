import {
  pendingStageQuestion,
  pendingTurnQuestion,
  type WorkflowRunStatus,
} from '@nesvo/contracts';
import type { Session } from '@/entities/session';
import type { WorkflowRun } from '@/entities/workflow';
import { formatRelativeTime } from '@/shared/lib/relative-time';
import type { StatusDotTone, StatusDotVariant } from '@/shared/ui/status-dot';

export type SessionIndicatorState =
  'running' | 'attention' | 'failed' | 'done' | 'idle' | 'offline';

export type SessionIndicator = {
  state: SessionIndicatorState;
  label: string;
  needsYou: boolean;
};

type SessionIndicatorInput = {
  session: Session;
  run: WorkflowRun | undefined;
  offline: boolean;
  awaitsReview: boolean;
  needsDecision: boolean;
  now: number;
};

const FAILURE_REASON_MAX_LENGTH = 80;

export const indicatorDots: Record<
  SessionIndicatorState,
  { tone: StatusDotTone; variant: StatusDotVariant }
> = {
  running: { tone: 'info', variant: 'spinner' },
  attention: { tone: 'warning', variant: 'solid' },
  failed: { tone: 'error', variant: 'solid' },
  done: { tone: 'success', variant: 'solid' },
  idle: { tone: 'neutral', variant: 'solid' },
  offline: { tone: 'neutral', variant: 'hollow' },
};

const runIndicators: Record<
  WorkflowRunStatus,
  { state: SessionIndicatorState; label: string }
> = {
  pending: { state: 'running', label: 'Workflow queued' },
  planning: { state: 'running', label: 'Workflow planning' },
  implementing: { state: 'running', label: 'Workflow implementing' },
  checking: { state: 'running', label: 'Running checks' },
  fixing: { state: 'running', label: 'Fixing failed checks' },
  'awaiting-human': { state: 'attention', label: 'Workflow waiting for you' },
  'needs-attention': {
    state: 'attention',
    label: 'Workflow needs your attention',
  },
  passed: { state: 'done', label: 'Checks passed' },
  failed: { state: 'failed', label: 'Checks failed' },
  rejected: { state: 'failed', label: 'Workflow rejected' },
  stopped: { state: 'idle', label: 'Workflow stopped' },
  interrupted: { state: 'failed', label: 'Workflow interrupted' },
};

function decisionLabel(session: Session) {
  if (session.plan?.status === 'plan-ready')
    return 'Plan waiting for your approval';
  if (pendingStageQuestion(session) || pendingTurnQuestion(session))
    return 'Question for you';
  if (session.parentRequest) return 'Session link waiting for your approval';
  if (session.coordinatorWait) return 'Coordinator waiting to continue';
  if (session.status === 'running' && session.pendingApprovals.length > 0)
    return 'Waiting for your approval';
  const current = session.delegations.filter(
    delegation => delegation.runId === session.runId,
  );
  if (
    session.status === 'running' &&
    current.some(delegation => delegation.status === 'pending')
  )
    return 'Worker waiting for your approval';
  if (
    session.delegations.some(delegation => delegation.status === 'plan-ready')
  )
    return 'Worker plan waiting for your review';
  return null;
}

function failureLabel(session: Session) {
  const reason = session.error?.split('\n')[0]?.trim();
  if (!reason) return 'Failed';
  return reason.length > FAILURE_REASON_MAX_LENGTH
    ? `Failed: ${reason.slice(0, FAILURE_REASON_MAX_LENGTH - 1)}…`
    : `Failed: ${reason}`;
}

function runningLabel(session: Session, now: number) {
  const started = session.messages.find(
    message => message.runId === session.runId,
  )?.createdAt;
  const elapsed = started ? formatRelativeTime(started, now) : '';
  return elapsed && elapsed !== 'now' ? `Running · ${elapsed}` : 'Running';
}

function sessionState(
  session: Session,
  now: number,
): { state: SessionIndicatorState; label: string } {
  switch (session.status) {
    case 'running':
      return { state: 'running', label: runningLabel(session, now) };
    case 'stopping':
      return { state: 'running', label: 'Stopping…' };
    case 'completed':
      return { state: 'done', label: 'Done' };
    case 'failed':
      return { state: 'failed', label: failureLabel(session) };
    case 'interrupted':
      return { state: 'failed', label: 'Interrupted' };
    case 'stopped':
      return { state: 'idle', label: 'Stopped' };
    case 'ready':
      return { state: 'idle', label: 'Ready' };
  }
}

export function sessionIndicator({
  session,
  run,
  offline,
  awaitsReview,
  needsDecision,
  now,
}: SessionIndicatorInput): SessionIndicator {
  if (offline) return { state: 'offline', label: 'Offline', needsYou: false };
  const decision = decisionLabel(session);
  if (decision) return { state: 'attention', label: decision, needsYou: true };
  const base =
    run && !session.workflowStepId && session.status !== 'failed'
      ? runIndicators[run.status]
      : sessionState(session, now);
  if (base.state === 'attention') return { ...base, needsYou: true };
  if (awaitsReview)
    return { state: 'attention', label: 'Result to review', needsYou: true };
  if (needsDecision)
    return { state: 'attention', label: 'Decision needed', needsYou: true };
  return { ...base, needsYou: false };
}
