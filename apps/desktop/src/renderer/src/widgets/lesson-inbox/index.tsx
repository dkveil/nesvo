import { useState } from 'react';
import {
  lessonIsDue,
  lessonNeedsDecision,
  localDate,
  type Computer,
  type Lesson,
  type LessonChanges,
} from '@nesvo/contracts';
import {
  LessonEditDialog,
  useLessonOverview,
  type LessonApi,
} from '@/features/lessons';
import type { Session } from '@/entities/session';
import { LessonRow } from '@/features/lessons/lesson-row';
import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';

type LessonInboxProps = {
  computers: Computer[];
  sessions: Session[];
  api: LessonApi;
  onSession: (sessionKey: string) => void;
};

type LessonTableProps = {
  computer: Computer;
  sessions: Session[];
  api: LessonApi;
  showLocation: boolean;
  onSession: (sessionKey: string) => void;
};

function LessonTable({
  computer,
  sessions,
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
      className="divide-y divide-border/55 border-b"
    >
      {lessons.error && (
        <StatusMessage tone="error" className="px-2">
          {lessons.error}
        </StatusMessage>
      )}
      <div className="divide-y">
        {rows.map(lesson => {
          const due = lessonIsDue(lesson, today);
          const source = lesson.evidence.find(item => item.sessionId);
          const session = sessions.find(
            item =>
              item.hostId === computer.id && item.id === source?.sessionId,
          );
          return (
            <LessonRow
              key={lesson.key}
              lesson={lesson}
              today={today}
              hostId={computer.id}
              computerName={showLocation ? computer.name : undefined}
              inboxContext={session ?? null}
              onSession={onSession}
            >
              <Button
                size="sm"
                variant="secondary"
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
                onClick={() => decide(lesson, due ? 'retire' : 'reject')}
              >
                {due ? 'Retire' : 'Reject'}
              </Button>
            </LessonRow>
          );
        })}
      </div>
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

export function LessonInbox({
  computers,
  sessions,
  api,
  onSession,
}: LessonInboxProps) {
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
          sessions={sessions}
          api={api}
          showLocation={ready.length > 1 || computer.id !== 'local'}
          onSession={onSession}
        />
      ))}
    </>
  );
}
