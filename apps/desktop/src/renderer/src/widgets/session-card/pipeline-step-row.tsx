import type { PipelinesApi } from '@nesvo/contracts';
import { Popover } from 'radix-ui';
import { cn } from 'cn';
import {
  phaseLabels,
  stepDuration,
  stepStateLabels,
  type PipelineRun,
  type PipelineStepRecord,
  type PipelineStepView,
} from '@/entities/pipeline';
import { StepStateIcon } from '@/entities/pipeline/step-state-icon';
import { StepResult, type InboxTarget } from '@/widgets/pipeline-step-result';
import { cardRowAction } from '@/shared/ui/card-row-styles';

type Props = {
  run: PipelineRun;
  steps: PipelineStepRecord[];
  step: PipelineStepView;
  now: number;
  open: boolean;
  api: Pick<PipelinesApi, 'readEvidence'>;
  onOpenChange: (open: boolean) => void;
  onInbox: (target: InboxTarget) => void;
  onSession: (key: string) => void;
};

export function PipelineStepRow({
  run,
  steps,
  step,
  now,
  open,
  api,
  onOpenChange,
  onInbox,
  onSession,
}: Props) {
  const duration = stepDuration(step, now);
  const maxAttempts = step.definition.retries + 1;
  const attempt = step.attempts > 1 ? `${step.attempts}/${maxAttempts}` : '';
  const label = [
    step.definition.name,
    stepStateLabels[step.state],
    attempt ? `attempt ${step.attempts} of ${maxAttempts}` : '',
    duration,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <li>
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger asChild>
          <button
            type="button"
            data-card-row
            data-step-row
            data-step-state={step.state}
            aria-label={label}
            title={label}
            className={cn(
              cardRowAction,
              'pl-8.5 font-normal aria-expanded:bg-highlight',
              step.state === 'pending' && 'text-muted-foreground',
            )}
          >
            <StepStateIcon state={step.state} />
            <span className="min-w-0 flex-1 truncate">
              {step.definition.name}
            </span>
            {attempt && (
              <span className="shrink-0 text-2xs text-warning-foreground tabular-nums">
                {attempt}
              </span>
            )}
            {duration && (
              <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                {duration}
              </span>
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="left"
            align="start"
            sideOffset={12}
            collisionPadding={12}
            aria-label={`${step.definition.name} result`}
            data-step-result={step.index}
            className="z-50 flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[min(20rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-(--popover-border) bg-card text-card-foreground shadow-(--popover-shadow) outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          >
            <header className="flex h-9 shrink-0 items-center gap-2.5 border-b px-3">
              <StepStateIcon state={step.state} className="size-4" />
              <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium">
                {step.definition.name}
              </h3>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {phaseLabels[step.definition.phase]}
              </span>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              <StepResult
                run={run}
                steps={steps}
                index={step.index}
                api={api}
                onInbox={onInbox}
                onSession={onSession}
              />
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </li>
  );
}
