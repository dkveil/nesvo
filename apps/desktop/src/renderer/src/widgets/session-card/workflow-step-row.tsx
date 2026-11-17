import type { WorkflowsApi } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import {
  phaseLabels,
  stepDuration,
  stepStateLabels,
  type WorkflowRun,
  type WorkflowStepRecord,
  type WorkflowStepView,
} from '@/entities/workflow';
import { StepStateIcon } from '@/entities/workflow/step-state-icon';
import { StepResult, type InboxTarget } from '@/widgets/workflow-step-result';
import { ListRow } from '@/shared/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { cardRowProps } from './card-row';

type Props = {
  run: WorkflowRun;
  steps: WorkflowStepRecord[];
  step: WorkflowStepView;
  now: number;
  open: boolean;
  api: Pick<WorkflowsApi, 'readEvidence'>;
  onOpenChange: (open: boolean) => void;
  onInbox: (target: InboxTarget) => void;
  onSession: (key: string) => void;
};

const STEP_LEVEL = 2;

export function WorkflowStepRow({
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
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <ListRow
            level={STEP_LEVEL}
            leading={<StepStateIcon state={step.state} />}
            title={step.definition.name}
            trailing={
              <>
                {attempt && (
                  <span className="text-warning-foreground">{attempt}</span>
                )}
                {duration}
              </>
            }
            className={cn(
              'data-[state=open]:bg-highlight',
              step.state === 'pending' && 'text-muted-foreground',
            )}
            mainProps={{
              ...cardRowProps,
              'data-step-row': '',
              'data-step-state': step.state,
              'aria-label': label,
            }}
          />
        </PopoverTrigger>
        <PopoverContent
          side="left"
          align="start"
          sideOffset={12}
          collisionPadding={12}
          surface="card"
          size="md"
          padding="none"
          aria-label={`${step.definition.name} result`}
          data-step-result={step.index}
          className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] flex-col overflow-hidden"
        >
          <header className="flex h-9 shrink-0 items-center gap-2.5 border-b px-3">
            <StepStateIcon state={step.state} className="size-4" />
            <h3 className="min-w-0 flex-1 truncate text-ui font-medium">
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
        </PopoverContent>
      </Popover>
    </li>
  );
}
