import { useEffect, useRef } from 'react';
import { latestStageReport, pendingStageQuestion } from '@nesvo/contracts';
import { entityKey } from '@/shared/lib/host-key';
import { readNotificationsEnabled } from '@/shared/lib/notification-preference';
import type { Session } from '@/entities/session';

type Snapshot = {
  status: Session['status'];
  pending: number;
  plan: string | null;
  question: string | null;
  report: string | null;
};

const working: Session['status'][] = ['running', 'stopping'];

function pendingCount(session: Session) {
  return (
    session.pendingApprovals.length +
    session.delegations.filter(item => item.status === 'pending').length
  );
}

function notify(
  title: string,
  session: Session,
  onOpen: (key: string) => void,
) {
  const key = entityKey(session);
  const show = () => {
    const notification = new Notification(title, {
      tag: key,
    });
    notification.onclick = () => {
      void window.nesvo.focusWindow().catch(() => window.focus());
      onOpen(key);
    };
  };
  if (
    title === 'Approval needed' ||
    title === 'Plan ready' ||
    title === 'Question waiting'
  )
    void window.nesvo.requestAttention().catch(() => undefined);
  if (!readNotificationsEnabled()) return;
  if (Notification.permission === 'granted') show();
  else if (Notification.permission === 'default')
    void Notification.requestPermission().then(permission => {
      if (permission === 'granted') show();
    });
}

function readyPlan(session: Session) {
  return session.plan?.status === 'plan-ready' ? session.plan.id : null;
}

function snapshotOf(session: Session): Snapshot {
  return {
    status: session.status,
    pending: pendingCount(session),
    plan: readyPlan(session),
    question: pendingStageQuestion(session)?.id ?? null,
    report: latestStageReport(session)?.id ?? null,
  };
}

function attentionTitle(previous: Snapshot, session: Session) {
  if (pendingCount(session) > previous.pending) return 'Approval needed';
  const next = snapshotOf(session);
  if (next.plan && next.plan !== previous.plan) return 'Plan ready';
  if (next.question && next.question !== previous.question)
    return 'Question waiting';
  if (next.report && next.report !== previous.report) return 'Report ready';
  if (session.status === previous.status) return null;
  if (!working.includes(previous.status)) return null;
  if (session.status === 'completed') return 'Finished';
  if (session.status === 'failed' || session.status === 'interrupted')
    return 'Needs attention';
  return null;
}

export function useAttention(
  sessions: Session[],
  onOpen: (key: string) => void,
) {
  const snapshots = useRef(new Map<string, Snapshot>());
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  });
  useEffect(() => {
    const previous = snapshots.current;
    const next = new Map<string, Snapshot>();
    for (const session of sessions) {
      const key = entityKey(session);
      const snapshot = snapshotOf(session);
      next.set(key, snapshot);
      const before = previous.get(key);
      if (
        !before ||
        document.hasFocus() ||
        session.role === 'worker' ||
        session.workflowRunId
      )
        continue;
      const title = attentionTitle(before, session);
      if (title) notify(title, session, openRef.current);
    }
    snapshots.current = next;
  }, [sessions]);
}
