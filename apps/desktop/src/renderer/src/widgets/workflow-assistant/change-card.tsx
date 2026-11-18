import { useState } from 'react';
import type {
  AssistantChange,
  AssistantChangeRefusal,
  AssistantUndoResult,
} from '@nesvo/contracts';
import {
  CalendarClock,
  Lightbulb,
  Terminal,
  Undo2,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { errorDetail } from '@/entities/session';
import { StatusIcon } from '@/entities/status';
import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';

const kindIcons: Record<AssistantChange['kind'], LucideIcon> = {
  step: Terminal,
  workflow: Workflow,
  automation: CalendarClock,
  lesson: Lightbulb,
  'gate-rule': Lightbulb,
};

const kindLabels: Record<AssistantChange['kind'], string> = {
  step: 'step',
  workflow: 'workflow',
  automation: 'automation',
  lesson: 'lesson',
  'gate-rule': 'gate rule',
};

const opLabels: Record<AssistantChange['op'], string> = {
  create: 'Added',
  update: 'Updated',
  delete: 'Removed',
};

const reasonLabels: Record<AssistantChangeRefusal['reason'], string> = {
  invalid: 'Refused: the change is invalid',
  conflict: 'Refused: the file changed meanwhile',
  unsafe: 'Refused: an external action needs a human step first',
  unavailable: 'Refused: not available on this computer',
};

const changeName = (change: AssistantChange) =>
  change.target.type === 'definition'
    ? change.target.name
    : change.summary.split('\n')[0]!;

type ChangeProps = {
  change: AssistantChange;
  onUndo: (change: AssistantChange) => Promise<AssistantUndoResult>;
  onOpen?: (change: AssistantChange) => void;
};

export function ChangeCard({ change, onUndo, onOpen }: ChangeProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const Icon = kindIcons[change.kind];
  const undone = change.status === 'undone';
  const undo = async () => {
    setBusy(true);
    setNote('');
    try {
      const result = await onUndo(change);
      if (result.status === 'conflict') setNote(result.message);
      else if (result.status === 'refused')
        setNote(result.issues.map(issue => issue.message).join(' '));
    } catch (error) {
      setNote(errorDetail(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-assistant-change={change.changeId}
      data-assistant-change-status={change.status}
      className={cn(
        'flex min-w-0 items-start gap-2.5 rounded-surface border px-2.5 py-2',
        undone && 'opacity-50',
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-accent text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">
            {undone ? 'Undone' : opLabels[change.op]} {kindLabels[change.kind]}
          </span>
          {onOpen && !undone ? (
            <Button
              type="button"
              variant="link"
              size="xs"
              className="min-w-0 px-0 font-mono text-foreground"
              onClick={() => onOpen(change)}
            >
              <span className="truncate">{changeName(change)}</span>
            </Button>
          ) : (
            <span className="min-w-0 truncate font-mono font-medium">
              {changeName(change)}
            </span>
          )}
        </div>
        <p className="text-2xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
          {change.summary}
        </p>
        {note && <StatusMessage tone="error">{note}</StatusMessage>}
      </div>
      {!undone && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground"
          disabled={busy}
          aria-label={`Undo: ${change.summary}`}
          onClick={() => void undo()}
        >
          <Undo2 />
          {busy ? 'Undoing…' : 'Undo'}
        </Button>
      )}
    </div>
  );
}

export function RefusalCard({ refusal }: { refusal: AssistantChangeRefusal }) {
  return (
    <div
      role="status"
      data-assistant-refusal
      className="flex min-w-0 items-start gap-2.5 rounded-surface border border-warning-foreground/40 px-2.5 py-2"
    >
      <StatusIcon
        status={refusal.reason === 'unsafe' ? 'error' : 'warning'}
        className="mt-0.5 size-4"
      />
      <div className="min-w-0 flex-1 space-y-0.5 text-2xs leading-4">
        <p className="text-xs font-medium">{reasonLabels[refusal.reason]}</p>
        {refusal.summary && (
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            {refusal.summary}
          </p>
        )}
        {refusal.issues.slice(0, 3).map((issue, index) => (
          <p
            key={index}
            className="text-muted-foreground [overflow-wrap:anywhere]"
          >
            {issue.message}
          </p>
        ))}
      </div>
    </div>
  );
}
