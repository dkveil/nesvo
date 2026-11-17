import { useState } from 'react';
import type {
  AssistantChange,
  AssistantChangeRefusal,
  AssistantUndoResult,
} from '@nesvo/contracts';
import {
  CalendarClock,
  CircleX,
  Terminal,
  TriangleAlert,
  Undo2,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';

const kindIcons: Record<AssistantChange['kind'], LucideIcon> = {
  step: Terminal,
  workflow: Workflow,
  automation: CalendarClock,
};

const kindLabels: Record<AssistantChange['kind'], string> = {
  step: 'step',
  workflow: 'workflow',
  automation: 'automation',
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
        'flex min-w-0 items-start gap-2.5 rounded-xl border px-2.5 py-2',
        undone && 'opacity-60',
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground">
            {undone ? 'Undone' : opLabels[change.op]} {kindLabels[change.kind]}
          </span>
          {onOpen && !undone ? (
            <button
              type="button"
              className="min-w-0 truncate font-mono font-medium underline-offset-2 outline-none hover:underline focus-visible:underline"
              onClick={() => onOpen(change)}
            >
              {changeName(change)}
            </button>
          ) : (
            <span className="min-w-0 truncate font-mono font-medium">
              {changeName(change)}
            </span>
          )}
        </div>
        <p className="text-2xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
          {change.summary}
        </p>
        {note && (
          <p role="alert" className="text-2xs leading-4 text-destructive">
            {note}
          </p>
        )}
      </div>
      {!undone && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 text-muted-foreground"
          disabled={busy}
          aria-label={`Undo: ${change.summary}`}
          title="Undo this change"
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
  const Icon = refusal.reason === 'unsafe' ? CircleX : TriangleAlert;
  return (
    <div
      role="status"
      data-assistant-refusal
      className="flex min-w-0 items-start gap-2.5 rounded-xl border border-warning-foreground/40 px-2.5 py-2"
    >
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          refusal.reason === 'unsafe'
            ? 'text-error-foreground'
            : 'text-warning-foreground',
        )}
        aria-hidden="true"
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
