import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { elapsedLabel } from '@/entities/activity';
import { ProviderGlyph, type Session } from '@/entities/session';
import { ListRow } from '@/shared/ui/list-row';

import { activeChild } from '@/widgets/delegations/worker-status';

export function TurnChildren({
  children,
  onOpen,
}: {
  children: Session[];
  onOpen: (session: Session) => void;
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
        const status = running
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
