import { type KeyboardEvent } from 'react';
import { ChevronRight, Play, Square, Workflow } from 'lucide-react';
import { cn } from 'cn';
import {
  canResumeRun,
  isRunActive,
  phaseLabels,
  pipelinePhases,
  pipelineSteps,
  runStatusLabel,
  runStatusTones,
  stepDuration,
  stepStateLabels,
  toneText,
  type PipelineRun,
  type PipelineStepRecord,
  type PipelineStepView,
} from '@/entities/pipeline';
import { StepStateIcon } from '@/entities/pipeline/step-state-icon';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';

type Props = {
  run: PipelineRun;
  steps: PipelineStepRecord[];
  selectedIndex: number | null;
  connected: boolean;
  pending: boolean;
  error: string;
  onSelectStep: (index: number) => void;
  onStop: () => void;
  onResume: () => void;
};

const SECOND_MS = 1000;

export function RunStatusBadge({ run }: { run: PipelineRun }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-2xs font-medium',
        toneText[runStatusTones[run.status]],
      )}
    >
      {runStatusLabel(run.status)}
    </span>
  );
}

const focusSibling = (event: KeyboardEvent<HTMLButtonElement>) => {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const chips = [
    ...(event.currentTarget
      .closest('[data-pipeline-strip]')
      ?.querySelectorAll<HTMLButtonElement>('[data-step-chip]') ?? []),
  ];
  const index = chips.indexOf(event.currentTarget);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? chips.length - 1
        : index + (event.key === 'ArrowRight' ? 1 : -1);
  const target = chips[Math.min(Math.max(next, 0), chips.length - 1)];
  if (!target) return;
  event.preventDefault();
  target.focus();
};

const focusIndex = (steps: PipelineStepView[], run: PipelineRun) =>
  run.currentStepIndex ??
  steps.findLast(step => step.state !== 'pending')?.index ??
  0;

export function PipelineStrip({
  run,
  steps,
  selectedIndex,
  connected,
  pending,
  error,
  onSelectStep,
  onStop,
  onResume,
}: Props) {
  const now = useNow(SECOND_MS);
  const views = pipelineSteps(run, steps);
  const phases = pipelinePhases(views);
  const current = views[focusIndex(views, run)];
  const active = isRunActive(run);
  const resumable = canResumeRun(run);
  const chip = (step: PipelineStepView) => {
    const duration = stepDuration(step, now);
    const label = `${step.definition.name} · ${stepStateLabels[step.state]}`;
    return (
      <li key={step.index} className="min-w-0">
        <button
          type="button"
          data-step-chip
          data-step-state={step.state}
          aria-label={label}
          aria-pressed={selectedIndex === step.index}
          title={[
            label,
            step.attempts > 1 ? `Attempt ${step.attempts}` : '',
            duration,
          ]
            .filter(Boolean)
            .join(' · ')}
          onKeyDown={focusSibling}
          onClick={() => onSelectStep(step.index)}
          className={cn(
            'inline-flex h-6 max-w-48 items-center gap-1.5 rounded-md px-1.5 text-xs text-foreground transition-colors duration-100 outline-none',
            'hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-highlight',
            step.state === 'pending' && 'text-muted-foreground',
          )}
        >
          <StepStateIcon state={step.state} />
          <span className="truncate">{step.definition.name}</span>
          {step.attempts > 1 && (
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              ×{step.attempts}
            </span>
          )}
          {duration && (
            <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
              {duration}
            </span>
          )}
        </button>
      </li>
    );
  };
  return (
    <section
      aria-label="Pipeline"
      data-pipeline-strip
      data-run-status={run.status}
      className="@container mx-auto mb-2 w-full max-w-(--composer-max-width) rounded-xl border px-2 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Workflow
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="shrink-0 text-xs font-medium">
          {run.pipeline.name}
        </span>
        <RunStatusBadge run={run} />
        {run.attention && (
          <span
            className="hidden min-w-0 truncate text-2xs text-muted-foreground @min-[34rem]:inline"
            title={run.attention}
          >
            {run.attention}
          </span>
        )}
        <span className="flex-1" />
        {current && (
          <button
            type="button"
            aria-label={`Open ${current.definition.name} result`}
            onClick={() => onSelectStep(current.index)}
            className="inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset @min-[34rem]:hidden"
          >
            <StepStateIcon state={current.state} className="size-3" />
            <span className="truncate">{current.definition.name}</span>
            <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
          </button>
        )}
        {resumable && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 px-2 text-2xs"
            disabled={!connected || pending}
            onClick={onResume}
          >
            <Play />
            Resume
          </Button>
        )}
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 px-2 text-2xs text-muted-foreground"
            disabled={!connected || pending}
            onClick={onStop}
            aria-label="Stop pipeline"
            title="Stop pipeline"
          >
            <Square className="fill-current" />
            <span className="hidden @min-[34rem]:inline">Stop pipeline</span>
          </Button>
        )}
      </div>
      <div className="mt-1 hidden space-y-0.5 @min-[34rem]:block">
        {phases.map(group => (
          <div key={group.phase} className="flex min-w-0 items-center gap-2">
            <span className="w-20 shrink-0 pl-0.5 text-2xs text-muted-foreground">
              {phaseLabels[group.phase]}
            </span>
            <ul
              role="list"
              aria-label={`${phaseLabels[group.phase]} steps`}
              className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5"
            >
              {group.steps.map(chip)}
            </ul>
          </div>
        ))}
      </div>
      {error && (
        <p
          role="alert"
          className="mt-1 px-0.5 text-2xs text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
    </section>
  );
}
