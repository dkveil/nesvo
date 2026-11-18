import { cn } from '@/shared/lib/cn';
import { useNow } from '@/shared/lib/use-now';
import {
  formatAgo,
  formatDateTime,
  sessionLastActivityAt,
  type Session,
} from '@/entities/session';
import { cardSection } from '@/shared/ui/card-row-styles';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { Hint } from '@/shared/ui/tooltip';

type Props = { session: Session };

const LIFECYCLE_CLOCK_MS = 60_000;

function Moment({ at, now }: { at: string; now: number }) {
  return (
    <Hint label={formatDateTime(at)} side="left">
      <time dateTime={at} className="tabular-nums">
        {formatAgo(at, now)}
      </time>
    </Hint>
  );
}

export function LifecycleSection({ session }: Props) {
  const now = useNow(LIFECYCLE_CLOCK_MS);
  const lastActivity = sessionLastActivityAt(session);
  return (
    <section
      aria-label="Lifecycle"
      data-session-lifecycle-section=""
      className={cn(cardSection, 'py-2')}
    >
      <KeyValueList
        className="px-2.5"
        entries={[
          {
            key: 'created',
            label: 'Created',
            value: <Moment at={session.createdAt} now={now} />,
          },
          {
            key: 'last-activity',
            label: 'Last activity',
            value: <Moment at={lastActivity} now={now} />,
          },
          ...(session.archivedAt
            ? [
                {
                  key: 'archived',
                  label: 'Archived',
                  value: <Moment at={session.archivedAt} now={now} />,
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}
