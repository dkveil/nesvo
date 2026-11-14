import { Check, Ellipsis, Play, RotateCcw, Square } from 'lucide-react';
import {
  canResumeRun,
  isRunActive,
  type PipelineRun,
  type PipelineStepView,
} from '@/entities/pipeline';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { cardIconButton } from '@/shared/ui/card-row-styles';

type Props = {
  run: PipelineRun;
  views: PipelineStepView[];
  disabled: boolean;
  onStop: () => void;
  onResume: () => void;
  onConfirmAction: (stepId: string) => void;
};

export function PipelineMenu({
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
        <button
          type="button"
          aria-label="Pipeline actions"
          title="Pipeline actions"
          className={cardIconButton}
        >
          <Ellipsis className="size-4" aria-hidden="true" />
        </button>
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
            Stop pipeline
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
