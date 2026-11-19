import {
  isWorkerInterruptedByRestart,
  type CoordinatorWakeState,
  type DecisionRoute,
  type DesktopSession,
} from '@nesvo/contracts';
import type { Review } from '@/entities/review';
import type { HostedInboxItem } from '@/features/inbox-rules';
import { entityKey, hostKey } from '@/shared/lib/host-key';
import {
  sessionDecisionRows,
  type SessionDecisionRow,
} from '@/widgets/review-inbox/decision-rows';

export type InboxTarget = { hostId: string; id: string };

export const orchestrationAnchor = (key: string) => `orchestration-${key}`;
type Decision = { inbox?: InboxTarget; sessionKey: string };

export type OrchestrationNode = {
  session: DesktopSession;
  children: OrchestrationNode[];
  decision?: Decision;
  wake?: 'Waiting for children' | 'Updates waiting' | 'Continue required';
  status:
    | 'Running'
    | 'Waiting for you'
    | 'Queued'
    | 'Done'
    | 'Failed'
    | 'Interrupted'
    | 'Continue after restart'
    | 'Stopped'
    | 'Ready';
  startedAt: string;
  finishedAt: string | null;
};

const running = (session: DesktopSession) =>
  session.status === 'running' || session.status === 'stopping';

function decisionSession(row: SessionDecisionRow) {
  if (row.type === 'review')
    return hostKey(row.review.sessionId, row.review.hostId);
  if (row.type === 'rule')
    return row.item.sessionId
      ? hostKey(row.item.sessionId, row.item.hostId)
      : null;
  return entityKey(row.session);
}

function decisionsBySession(
  sessions: DesktopSession[],
  reviews: Review[],
  items: HostedInboxItem[],
  routeOf: (session: DesktopSession) => DecisionRoute,
) {
  const inbox = new Set(
    sessionDecisionRows(sessions, reviews, items, routeOf).map(row => row.id),
  );
  const rows = sessionDecisionRows(
    sessions,
    reviews,
    items,
    routeOf,
    'pending',
    true,
  )
    .filter(row => row.type !== 'coordinator-wait')
    .sort(
      (left, right) =>
        Number(inbox.has(right.id)) - Number(inbox.has(left.id)) ||
        right.at.localeCompare(left.at),
    );
  const bySession = new Map<string, Decision>();
  const byKey = new Map(sessions.map(session => [entityKey(session), session]));
  for (const row of rows) {
    const key = decisionSession(row);
    if (!key) continue;
    const session = byKey.get(key);
    if (!session || bySession.has(key)) continue;
    bySession.set(key, {
      sessionKey: session.parentId
        ? hostKey(session.parentId, session.hostId)
        : key,
      ...(inbox.has(row.id)
        ? {
            inbox: {
              hostId: session.hostId,
              id: row.type === 'rule' ? row.item.id : row.id,
            },
          }
        : {}),
    });
  }
  for (const parent of sessions) {
    for (const proposal of parent.delegations) {
      if (proposal.status !== 'plan-ready' || !proposal.childSessionId)
        continue;
      const key = hostKey(proposal.childSessionId, parent.hostId);
      if (!bySession.has(key))
        bySession.set(key, { sessionKey: entityKey(parent) });
    }
  }
  return bySession;
}

function nodeStatus(
  session: DesktopSession,
  decision: Decision | undefined,
  state: CoordinatorWakeState | undefined,
): OrchestrationNode['status'] {
  if (decision) return 'Waiting for you';
  if (
    isWorkerInterruptedByRestart(session) ||
    state?.reason === 'restart' ||
    session.coordinatorWait?.away
  )
    return 'Continue after restart';
  if (running(session)) return 'Running';
  if (session.queue.length) return 'Queued';
  switch (session.status) {
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    case 'stopped':
      return 'Stopped';
    default:
      return 'Ready';
  }
}

function wakeLabel(
  session: DesktopSession,
  children: OrchestrationNode[],
  state?: CoordinatorWakeState,
): OrchestrationNode['wake'] {
  if (state?.continueRequired) return 'Continue required';
  if (state?.pending) return 'Updates waiting';
  if (
    state?.effective &&
    (!running(session) ||
      (session.coordinatorWait?.runId === session.runId &&
        !session.coordinatorWait?.away)) &&
    children.some(
      child =>
        running(child.session) || child.session.queue.some(item => !item.held),
    )
  )
    return 'Waiting for children';
}

const liveTree = (
  node: OrchestrationNode,
  workflowSessions: ReadonlySet<string>,
): boolean =>
  !!node.wake ||
  (node.children.length > 0 && workflowSessions.has(entityKey(node.session))) ||
  (node.status !== 'Done' &&
    node.status !== 'Stopped' &&
    node.status !== 'Ready' &&
    node.status !== 'Failed') ||
  node.children.some(child => liveTree(child, workflowSessions));

export function orchestrationTrees(
  sessions: DesktopSession[],
  states: ReadonlyMap<string, CoordinatorWakeState>,
  reviews: Review[],
  items: HostedInboxItem[],
  routeOf: (session: DesktopSession) => DecisionRoute,
  workflowSessions: ReadonlySet<string>,
) {
  const visible = sessions.filter(session => !session.archivedAt);
  const byKey = new Map(visible.map(session => [entityKey(session), session]));
  const decisions = decisionsBySession(visible, reviews, items, routeOf);
  const children = new Map<string, DesktopSession[]>();
  for (const child of visible) {
    if (!child.parentId) continue;
    const parent = hostKey(child.parentId, child.hostId);
    if (!byKey.has(parent)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
  }
  for (const siblings of children.values())
    siblings.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );

  const node = (session: DesktopSession, depth: number): OrchestrationNode => {
    const key = entityKey(session);
    const descendants =
      depth < 2
        ? (children.get(key) ?? []).map(child => node(child, depth + 1))
        : [];
    const state = states.get(key);
    const decision = decisions.get(key);
    const run = session.messages.filter(
      message => message.runId === session.runId,
    );
    const startedAt = run[0]?.createdAt ?? session.createdAt;
    return {
      session,
      children: descendants,
      decision,
      wake: descendants.length
        ? wakeLabel(session, descendants, state)
        : undefined,
      status: nodeStatus(session, decision, state),
      startedAt,
      finishedAt: running(session)
        ? null
        : (run.at(-1)?.completedAt ??
          (session.runId ? session.updatedAt : startedAt)),
    };
  };
  return visible
    .filter(
      session =>
        children.has(entityKey(session)) &&
        (!session.parentId ||
          !byKey.has(hostKey(session.parentId, session.hostId))),
    )
    .map(session => node(session, 0))
    .filter(tree => liveTree(tree, workflowSessions));
}
