import {
  pendingStageQuestion,
  pendingTurnQuestion,
  routesToInbox,
  type DecisionRoute,
  type GateRuleProposal,
  type StageQuestionRecord,
} from '@nesvo/contracts';
import type { Review } from '@/entities/review';
import type { ScheduledJob } from '@/entities/scheduled-job';
import type { Session } from '@/entities/session';
import type { WorkflowRun, WorkflowStepRecord } from '@/entities/workflow';
import { inboxItemKey, type HostedInboxItem } from '@/features/inbox-rules';
import type { SteeringRequest } from '@/features/session-mode/steering-decision-actions';
import { entityKey } from '@/shared/lib/host-key';

export type Filter = 'pending' | 'history' | 'all';

export type ActionRow =
  | {
      type: 'gate-rule-proposal';
      row: GateRuleProposal;
      hostId: string;
      at: string;
      id: string;
    }
  | { type: 'coordinator-wait'; session: Session; at: string; id: string }
  | {
      type: 'steering';
      session: Session;
      request: SteeringRequest;
      at: string;
      id: string;
    }
  | { type: 'review'; review: Review; at: string; id: string }
  | {
      type: 'turn-question';
      session: Session;
      question: NonNullable<ReturnType<typeof pendingTurnQuestion>>;
      at: string;
      id: string;
    }
  | { type: 'rule'; item: HostedInboxItem; at: string; id: string }
  | { type: 'automation'; job: ScheduledJob; at: string; id: string }
  | {
      type: 'workflow-gate';
      run: WorkflowRun;
      step: WorkflowStepRecord;
      at: string;
      id: string;
    }
  | {
      type: 'approval';
      session: Session;
      approval: Session['pendingApprovals'][number];
      at: string;
      id: string;
    }
  | {
      type: 'delegation';
      session: Session;
      delegation: Session['delegations'][number];
      at: string;
      id: string;
    }
  | {
      type: 'parent';
      session: Session;
      request: NonNullable<Session['parentRequest']>;
      at: string;
      id: string;
    }
  | {
      type: 'plan';
      session: Session;
      plan: NonNullable<Session['plan']>;
      at: string;
      id: string;
    }
  | {
      type: 'question';
      session: Session;
      record: StageQuestionRecord;
      at: string;
      id: string;
    };

export type SessionDecisionRow = Exclude<
  ActionRow,
  { type: 'automation' | 'gate-rule-proposal' | 'workflow-gate' }
>;

export function sessionDecisionRows(
  sessions: Session[],
  reviews: Review[],
  ruleItems: HostedInboxItem[],
  routeOf: (session: Session) => DecisionRoute,
  filter: Filter = 'pending',
  includeParent = false,
) {
  const heldSessions = new Set(
    ruleItems
      .filter(item => item.status === 'pending' && item.binding === 'provider')
      .map(item => `${item.hostId}/${item.sessionId}`),
  );
  const routed = (route: DecisionRoute) =>
    includeParent || routesToInbox(route);
  const inInbox = (session: Session) => routed(routeOf(session));
  const rows: SessionDecisionRow[] = reviews
    .filter(
      review =>
        review.status !== 'done' &&
        routed(review.route ?? 'inbox') &&
        (filter === 'all' ||
          (filter === 'pending'
            ? review.status === 'pending'
            : review.status !== 'pending')),
    )
    .map(review => ({
      type: 'review',
      review,
      at: review.createdAt,
      id: entityKey(review),
    }));
  if (filter !== 'history')
    for (const session of sessions)
      if (session.coordinatorWait)
        rows.push({
          type: 'coordinator-wait',
          session,
          at: session.coordinatorWait.startedAt,
          id: entityKey(session),
        });
  if (filter !== 'history')
    for (const session of sessions)
      if (session.parentRequest)
        rows.push({
          type: 'parent',
          session,
          request: session.parentRequest,
          at: session.parentRequest.requestedAt,
          id: `${entityKey(session)}/${session.parentRequest.id}`,
        });
  for (const item of ruleItems)
    if (
      (routed(item.route) ||
        (item.binding === 'external' &&
          !sessions.some(
            session =>
              session.id === item.parentId &&
              session.hostId === item.hostId &&
              !session.archivedAt,
          ))) &&
      (filter === 'all' ||
        (filter === 'pending'
          ? item.status === 'pending'
          : item.status !== 'pending'))
    )
      rows.push({
        type: 'rule',
        item,
        at: item.decidedAt ?? item.createdAt,
        id: inboxItemKey(item),
      });
  if (filter !== 'history')
    for (const session of sessions) {
      if (session.status !== 'running' || !session.runId) continue;
      if (!inInbox(session)) continue;
      if (heldSessions.has(`${session.hostId}/${session.id}`)) continue;
      for (const approval of session.pendingApprovals)
        rows.push({
          type: 'approval',
          session,
          approval,
          at: session.updatedAt,
          id: `${entityKey(session)}/${session.runId}/${approval.id}`,
        });
      for (const delegation of session.delegations)
        if (
          delegation.status === 'pending' &&
          delegation.runId === session.runId
        )
          rows.push({
            type: 'delegation',
            session,
            delegation,
            at: session.updatedAt,
            id: `${entityKey(session)}/${session.runId}/${delegation.id}`,
          });
    }
  if (filter !== 'history')
    for (const session of sessions) {
      const key = entityKey(session);
      for (const request of session.steeringRequests ?? [])
        if (
          session.status === 'running' &&
          session.runId === request.runId &&
          routed(request.route)
        )
          rows.push({
            type: 'steering',
            session,
            request,
            at: request.createdAt,
            id: `${key}/${request.id}`,
          });
      if (inInbox(session) && session.plan?.status === 'plan-ready')
        rows.push({
          type: 'plan',
          session,
          plan: session.plan,
          at: session.plan.readyAt ?? session.updatedAt,
          id: `${key}/${session.plan.id}`,
        });
      const question = pendingStageQuestion(session);
      if (question && routed(session.questionRouteOverride ?? routeOf(session)))
        rows.push({
          type: 'question',
          session,
          record: question,
          at: question.at,
          id: `${key}/${question.id}`,
        });
      const turnQuestion = pendingTurnQuestion(session);
      if (turnQuestion && routed(turnQuestion.route))
        rows.push({
          type: 'turn-question',
          session,
          question: turnQuestion,
          at: session.updatedAt,
          id: `${key}/${turnQuestion.runId}`,
        });
    }
  return rows;
}
