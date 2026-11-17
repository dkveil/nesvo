import { Check, Ellipsis, Play, RotateCcw, Square } from 'lucide-react';
import {
  canResumeRun,
  isRunActive,
  type WorkflowRun,
  type WorkflowStepView,
} from '@/entities/workflow';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { IconButton } from '@/shared/ui/icon-button';

type Props = {
  run: WorkflowRun;
  views: WorkflowStepView[];
  disabled: boolean;
  onStop: () => void;
  onResume: () => void;
  onConfirmAction: (stepId: string) => void;
};

export function WorkflowMenu({
  run,
  views,
  disabled,
  onStop,
  onResume,
  onConfirmAction,
}: Props) {
  const current =
    run.currentStepIndex === null ? undefined : views[run.currentStepIndex];
  const uncertain =
    current?.state === 'uncertain' && canResumeRun(run) ? current.record : null;
  const resumable = canResumeRun(run) && !uncertain;
  const active = isRunActive(run);
  if (!uncertain && !resumable && !active) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton size={24} label="Workflow actions">
          <Ellipsis aria-hidden="true" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {uncertain && (
          <>
            <DropdownMenuItem
              disabled={disabled}
              onSelect={() => onConfirmAction(uncertain.id)}
            >
              <Check />
              It already ran
            </DropdownMenuItem>
            <DropdownMenuItem disabled={disabled} onSelect={onResume}>
              <RotateCcw />
              Run it again
            </DropdownMenuItem>
          </>
        )}
        {resumable && (
          <DropdownMenuItem disabled={disabled} onSelect={onResume}>
            <Play />
            Resume
          </DropdownMenuItem>
        )}
        {active && (
          <DropdownMenuItem disabled={disabled} onSelect={onStop}>
            <Square />
            Stop workflow
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
