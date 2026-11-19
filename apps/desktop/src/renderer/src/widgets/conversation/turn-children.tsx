import { useEffect, useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { pendingStageQuestion, pendingTurnQuestion } from '@nesvo/contracts';
import { IconButton } from '@/shared/ui/icon-button';
import { elapsedLabel } from '@/entities/activity';
import { ProviderGlyph, type Session } from '@/entities/session';
import { ListRow } from '@/shared/ui/list-row';

import { activeChild } from '@/widgets/delegations/worker-status';

export function TurnChildren({
  children,
  onOpen,
  onInspect,
  reviewPending,
}: {
  children: Session[];
  onOpen: (session: Session) => void;
  onInspect?: (session: Session, trigger: HTMLElement) => void;
  reviewPending?: (session: Session) => boolean;
}) {
  const live = children.some(activeChild);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return (
    <section
      aria-label="Child sessions"
      className="divide-y divide-border border-y border-border"
    >
      {children.map(child => {
        const running = activeChild(child);
        const needsDecision =
          child.pendingApprovals.length > 0 ||
          child.plan?.status === 'plan-ready' ||
          !!pendingStageQuestion(child) ||
          !!pendingTurnQuestion(child) ||
          !!child.steeringRequests?.length ||
          !!reviewPending?.(child);
        const status = needsDecision
          ? 'Needs a decision'
          : running
            ? 'Running'
            : child.status === 'completed'
              ? 'Done'
              : child.status === 'failed'
                ? 'Failed'
                : child.status === 'interrupted'
                  ? 'Interrupted'
                  : child.status === 'stopped'
                    ? 'Stopped'
                    : child.queue.length
                      ? 'Queued'
                      : 'Ready';
        const start = child.messages.find(
          message => message.runId === child.runId,
        )?.createdAt;
        const end = child.messages.findLast(
          message =>
            message.runId === child.runId && message.author === 'agent',
        )?.completedAt;
        return (
          <ListRow
            key={child.id}
            leading={<ProviderGlyph provider={child.provider} />}
            title={child.title}
            mainProps={{ title: child.title }}
            onClick={() => onOpen(child)}
            actionsPlacement="visible"
            actions={
              onInspect && (
                <IconButton
                  label={`Inspect ${child.title}`}
                  size={24}
                  onClick={event => onInspect(child, event.currentTarget)}
                >
                  <FileText />
                </IconButton>
              )
            }
            trailing={
              <>
                <span className="text-ui leading-5">{status}</span>
                {start && (running || end) && (
                  <span className="text-ui leading-5">
                    {elapsedLabel(start, running ? null : (end ?? null), now)}
                  </span>
                )}
                <ChevronRight aria-hidden="true" className="size-3.5" />
              </>
            }
          />
        );
      })}
    </section>
  );
}
