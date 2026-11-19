import type { ReactNode } from 'react';
import { lessonIsDue, type Lesson } from '@nesvo/contracts';
import { ArrowUpRight } from 'lucide-react';
import { hostKey } from '@/shared/lib/host-key';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { ListRow } from '@/shared/ui/list-row';
import {
  incidentKindLabels,
  lessonDate,
  lessonScopeText,
  lessonStatusText,
} from './labels';

export function LessonRow({
  lesson,
  today,
  hostId,
  computerName,
  onSession,
  metrics,
  children,
}: {
  lesson: Lesson;
  today: string;
  hostId: string;
  computerName?: string;
  onSession: (sessionKey: string) => void;
  metrics?: ReactNode;
  children: ReactNode;
}) {
  const due = lessonIsDue(lesson, today);
  const evidence = lesson.evidence.slice(0, 3);
  return (
    <ListRow
      density="block"
      columns="minmax(0,1fr) auto"
      data-lesson-key={lesson.key}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <p
            className="min-w-0 truncate text-ui font-medium"
            title={lesson.description}
          >
            {lesson.description}
          </p>
          {lesson.kind === 'check' && (
            <Badge size="xs" tone="info">
              Check
            </Badge>
          )}
          {(due || lesson.state !== 'active') && (
            <Badge
              size="xs"
              tone={due || lesson.state === 'proposed' ? 'warning' : 'neutral'}
            >
              {lessonStatusText(lesson, today)}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {lesson.body.rule}
        </p>
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span title={lesson.project ?? undefined}>
            {lessonScopeText(lesson)}
            {computerName && <> · {computerName}</>}
          </span>
          {evidence.map(item => (
            <span
              key={item.incidentId}
              className="inline-flex items-center gap-1.5"
            >
              <span aria-hidden="true">·</span>
              {item.sessionId ? (
                <Button
                  variant="link"
                  size="inline"
                  className="text-muted-foreground"
                  title={item.summary}
                  onClick={() => onSession(hostKey(item.sessionId!, hostId))}
                >
                  from {incidentKindLabels[item.kind]}
                  <ArrowUpRight className="size-3" />
                </Button>
              ) : (
                <span title={item.summary}>
                  from {incidentKindLabels[item.kind]}
                </span>
              )}
            </span>
          ))}
          {lesson.evidence.length > evidence.length && (
            <span>· +{lesson.evidence.length - evidence.length} more</span>
          )}
          {lesson.review && (
            <span>· review by {lessonDate(lesson.review)}</span>
          )}
          {lesson.enforcedBy !== 'none' && (
            <span>· enforced by {lesson.enforcedBy}</span>
          )}
          {lesson.id && <span className="sr-only">{lesson.id}</span>}
        </div>
        {metrics}
      </div>
      <div className="flex items-center gap-1 self-center">{children}</div>
    </ListRow>
  );
}
