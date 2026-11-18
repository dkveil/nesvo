import { useState } from 'react';
import {
  lessonIsDue,
  lessonNeedsDecision,
  localDate,
  type Computer,
  type Lesson,
  type LessonChanges,
} from '@nesvo/contracts';
import { ArrowUpRight } from 'lucide-react';
import {
  LessonEditDialog,
  incidentKindLabels,
  lessonDate,
  lessonScopeText,
  useLessonOverview,
  type LessonApi,
} from '@/features/lessons';
import { hostKey } from '@/shared/lib/host-key';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';

type LessonInboxProps = {
  computers: Computer[];
  api: LessonApi;
  onSession: (sessionKey: string) => void;
};

type LessonTableProps = {
  computer: Computer;
  api: LessonApi;
  showLocation: boolean;
  onSession: (sessionKey: string) => void;
};

const EVIDENCE_LINKS = 3;
const heading = 'h-7 px-2 text-left text-2xs font-medium whitespace-nowrap';

function LessonTable({
  computer,
  api,
  showLocation,
  onSession,
}: LessonTableProps) {
  const lessons = useLessonOverview({
    api,
    hostId: computer.id,
    enabled: true,
  });
  const [editing, setEditing] = useState<Lesson | null>(null);
  const [today] = useState(() => localDate(new Date()));
  const rows =
    lessons.overview?.lessons.filter(lesson =>
      lessonNeedsDecision(lesson, today),
    ) ?? [];
  if (!rows.length && !lessons.error) return null;
  const busy = lessons.pending !== null;
  const decide = (lesson: Lesson, decision: 'approve' | 'reject' | 'retire') =>
    void lessons.decide({
      key: lesson.key,
      expectedVersion: lesson.version,
      decision,
    });
  const submit = async (changes: LessonChanges) => {
    if (!editing) return;
    const done = await lessons.decide({
      key: editing.key,
      expectedVersion: editing.version,
      decision: editing.state === 'proposed' ? 'approve' : 'edit',
      changes,
    });
    if (done) setEditing(null);
  };
  return (
    <section
      aria-label={`Lessons on ${computer.name}`}
      className="mb-5 space-y-1.5"
    >
      <SectionLabel as="h2" count={rows.length} className="px-2">
        {showLocation ? `Lessons · ${computer.name}` : 'Lessons'}
      </SectionLabel>
      {lessons.error && (
        <StatusMessage tone="error" className="px-2">
          {lessons.error}
        </StatusMessage>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-surface border bg-card">
          <table className="w-full text-left text-xs">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className={heading} scope="col">
                  Lesson
                </th>
                <th className={heading} scope="col">
                  Scope
                </th>
                <th className={heading} scope="col">
                  Evidence
                </th>
                <th className={heading} scope="col">
                  Review
                </th>
                <th className={heading} scope="col">
                  <span className="sr-only">Decisions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border align-top">
              {rows.map(lesson => {
                const due = lessonIsDue(lesson, today);
                return (
                  <tr key={lesson.key} data-lesson-key={lesson.key}>
                    <td className="max-w-0 min-w-64 px-2 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {lesson.id && (
                          <span className="font-mono text-2xs text-muted-foreground">
                            {lesson.id}
                          </span>
                        )}
                        <span className="text-ui font-medium [overflow-wrap:anywhere]">
                          {lesson.description}
                        </span>
                        {due && (
                          <Badge size="xs" tone="warning">
                            Review due
                          </Badge>
                        )}
                        {lesson.kind === 'check' && (
                          <Badge size="xs" tone="info">
                            Check
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-3 text-muted-foreground [overflow-wrap:anywhere]">
                        {lesson.body.rule}
                      </p>
                    </td>
                    <td className="px-2 py-2">{lessonScopeText(lesson)}</td>
                    <td className="px-2 py-2">
                      <div className="flex flex-col items-start gap-0.5">
                        {lesson.evidence.slice(0, EVIDENCE_LINKS).map(item =>
                          item.sessionId ? (
                            <Button
                              key={item.incidentId}
                              variant="link"
                              size="inline"
                              className="text-2xs"
                              aria-label={`Open session: ${item.summary}`}
                              onClick={() =>
                                onSession(hostKey(item.sessionId!, computer.id))
                              }
                            >
                              {incidentKindLabels[item.kind]}
                              <ArrowUpRight className="size-3 text-muted-foreground" />
                            </Button>
                          ) : (
                            <span
                              key={item.incidentId}
                              className="text-2xs text-muted-foreground"
                            >
                              {incidentKindLabels[item.kind]}
                            </span>
                          ),
                        )}
                        {lesson.evidence.length > EVIDENCE_LINKS && (
                          <span className="text-2xs text-muted-foreground">
                            +{lesson.evidence.length - EVIDENCE_LINKS} more
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap tabular-nums">
                      {lesson.review ? lessonDate(lesson.review) : '—'}
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => decide(lesson, 'approve')}
                        >
                          {due ? 'Keep' : 'Approve'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setEditing(lesson)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            decide(lesson, due ? 'retire' : 'reject')
                          }
                        >
                          {due ? 'Retire' : 'Reject'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <LessonEditDialog
          lesson={editing}
          approve={editing.state === 'proposed'}
          pending={busy}
          error={lessons.error}
          onSubmit={changes => void submit(changes)}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

export function LessonInbox({ computers, api, onSession }: LessonInboxProps) {
  const ready = computers.filter(
    computer =>
      computer.status === 'connected' &&
      computer.capabilities.includes('lessons'),
  );
  return (
    <>
      {ready.map(computer => (
        <LessonTable
          key={`${computer.id}:${computer.instanceId ?? ''}`}
          computer={computer}
          api={api}
          showLocation={ready.length > 1 || computer.id !== 'local'}
          onSession={onSession}
        />
      ))}
    </>
  );
}
