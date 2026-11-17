import { Workflow } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  runStatusLabel,
  runStatusTones,
  toneText,
  type WorkflowRun,
} from '@/entities/workflow';
import { Chip } from '@/shared/ui/chip';
import { Hint } from '@/shared/ui/tooltip';

type Props = {
  run: WorkflowRun;
  open: boolean;
  onToggle: (trigger: HTMLButtonElement) => void;
};

export function WorkflowStatus({ run, open, onToggle }: Props) {
  const label = runStatusLabel(run.status);
  return (
    <Hint label={`Workflow ${run.workflow.name} · ${label}`}>
      <Chip
        data-workflow-status={run.status}
        data-session-card-trigger
        aria-label={`Workflow ${run.workflow.name}: ${label}`}
        aria-pressed={open}
        aria-controls={open ? 'session-card' : undefined}
        selected={open}
        icon={<Workflow aria-hidden="true" />}
        onClick={event => onToggle(event.currentTarget)}
        className={cn('font-medium', toneText[runStatusTones[run.status]])}
      >
        <span className="hidden sm:inline">{label}</span>
      </Chip>
    </Hint>
  );
}
