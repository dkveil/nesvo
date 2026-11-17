import { Workflow } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  runStatusLabel,
  runStatusTones,
  toneText,
  type WorkflowRun,
} from '@/entities/workflow';

type Props = {
  run: WorkflowRun;
  open: boolean;
  onToggle: (trigger: HTMLButtonElement) => void;
};

export function WorkflowStatus({ run, open, onToggle }: Props) {
  const label = runStatusLabel(run.status);
  return (
    <button
      type="button"
      data-workflow-status={run.status}
      data-session-card-trigger
      aria-label={`Workflow ${run.workflow.name}: ${label}`}
      aria-pressed={open}
      aria-controls={open ? 'session-card' : undefined}
      title={`Workflow ${run.workflow.name} · ${label}`}
      onClick={event => onToggle(event.currentTarget)}
      className={cn(
        'inline-flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors duration-100 outline-none',
        'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-highlight',
        toneText[runStatusTones[run.status]],
      )}
    >
      <Workflow className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="hidden truncate sm:inline">{label}</span>
    </button>
  );
}
