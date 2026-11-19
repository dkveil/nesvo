import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { lessonIsDue, type Lesson } from '@nesvo/contracts';
import { ArrowUpRight } from 'lucide-react';
import { DecisionRow } from '@/entities/review/decision-row';
import { cn } from '@/shared/lib/cn';
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

function LessonTitle({ text }: { text: string }) {
  const id = useId();
  const title = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const element = title.current;
    if (!element || expanded) return;
    const measure = () =>
      setClipped(element.scrollHeight > element.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <>
      <p
        id={id}
        ref={title}
        className={cn(
          'font-normal [overflow-wrap:anywhere]',
          !expanded && 'line-clamp-2',
        )}
      >
        {text}
      </p>
      {(clipped || expanded) && (
        <Button
          size="inline"
          variant="link"
          className="text-xs"
          aria-controls={id}
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? 'Less' : 'More'}
        </Button>
      )}
    </>
  );
}

export function LessonRow({
  lesson,
  today,
  hostId,
  computerName,
  inboxContext,
  onSession,
  metrics,
  children,
}: {
  lesson: Lesson;
  today: string;
  hostId: string;
  computerName?: string;
  inboxContext?: { id: string; title: string } | null;
  onSession: (sessionKey: string) => void;
  metrics?: ReactNode;
  children: ReactNode;
}) {
  const due = lessonIsDue(lesson, today);
  const evidence = lesson.evidence.slice(0, 3);
  const checkBadge = lesson.kind === 'check' && (
    <Badge size="xs" tone="info">
      Check
    </Badge>
  );
  const heading = (
    <div className="flex min-w-0 items-center gap-2">
      <p
        className="min-w-0 truncate text-ui font-medium"
        title={lesson.description}
      >
        {lesson.description}
      </p>
      {checkBadge}
      {(due || lesson.state !== 'active') && (
        <Badge
          size="xs"
          tone={due || lesson.state === 'proposed' ? 'warning' : 'neutral'}
        >
          {lessonStatusText(lesson, today)}
        </Badge>
      )}
    </div>
  );
  const details = (
    <>
      {inboxContext !== undefined && (
        <p className="text-2xs text-muted-foreground">
          {due ? 'Lesson due for review' : 'Proposes a lesson to keep'}
        </p>
      )}
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {lesson.body.rule}
      </p>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        {inboxContext !== undefined && checkBadge}
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
                aria-label={`Open session: ${item.summary}`}
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
          <span>
            <span aria-hidden="true">·</span>{' '}
            <time dateTime={lesson.review}>
              Review by {lessonDate(lesson.review)}
            </time>
          </span>
        )}
        {lesson.enforcedBy !== 'none' && (
          <span>· enforced by {lesson.enforcedBy}</span>
        )}
        {lesson.id && <span className="sr-only">{lesson.id}</span>}
      </div>
      {metrics}
    </>
  );
  if (inboxContext !== undefined) {
    return (
      <article
        data-lesson-key={lesson.key}
        aria-label={due ? 'Lesson review' : 'Lesson proposal'}
      >
        <DecisionRow
          alignActions="summary"
          heading={
            <>
              {inboxContext && (
                <Button
                  variant="link"
                  size="inline"
                  className="min-w-0 max-w-full"
                  onClick={() => onSession(hostKey(inboxContext.id, hostId))}
                >
                  <span className="truncate">{inboxContext.title}</span>
                  <ArrowUpRight />
                </Button>
              )}
              <LessonTitle text={lesson.description} />
            </>
          }
          details={details}
        >
          <div data-inbox-actions className="flex-wrap">
            {children}
          </div>
        </DecisionRow>
      </article>
    );
  }
  return (
    <ListRow
      density="block"
      columns="minmax(0,1fr) auto"
      data-lesson-key={lesson.key}
    >
      <div className="min-w-0 space-y-1">
        {heading}
        {details}
      </div>
      <div className="flex items-center gap-1 self-center">{children}</div>
    </ListRow>
  );
}
