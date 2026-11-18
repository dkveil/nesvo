import type { DesktopSession as Session } from '@nesvo/contracts';
import { formatDateTime } from '@/shared/lib/format-date';
import { formatRelativeTime } from '@/shared/lib/relative-time';

type LifecycleSession = Pick<
  Session,
  'createdAt' | 'updatedAt' | 'archivedAt' | 'messages'
>;

export type SessionLifecycle = {
  created: string;
  lastActivity: string;
  archived: string | null;
};

export { formatDateTime };

export function formatAgo(isoDate: string, now: number) {
  const relative = formatRelativeTime(isoDate, now);
  if (!relative) return '';
  return relative === 'now' ? 'just now' : `${relative} ago`;
}

export function sessionLastActivityAt(session: LifecycleSession) {
  return session.messages.reduce(
    (latest, message) =>
      [message.createdAt, message.completedAt ?? ''].reduce(
        (current, value) => (value > current ? value : current),
        latest,
      ),
    session.updatedAt > session.createdAt
      ? session.updatedAt
      : session.createdAt,
  );
}

export function sessionLifecycle(
  session: LifecycleSession,
  now: number,
): SessionLifecycle {
  return {
    created: `Created ${formatDateTime(session.createdAt)} (${formatAgo(session.createdAt, now)})`,
    lastActivity: `Last activity ${formatAgo(sessionLastActivityAt(session), now)}`,
    archived: session.archivedAt
      ? `Archived ${formatAgo(session.archivedAt, now)}`
      : null,
  };
}

export function sessionLifecycleLines(lifecycle: SessionLifecycle) {
  return [lifecycle.created, lifecycle.lastActivity, lifecycle.archived].filter(
    (line): line is string => !!line,
  );
}
