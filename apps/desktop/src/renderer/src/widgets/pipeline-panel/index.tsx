import { useEffect, useEffectEvent, useRef, type KeyboardEvent } from 'react';
import type { PipelinesApi } from '@nesvo/contracts';
import { Check, Play, RotateCcw, Square, Workflow, X } from 'lucide-react';
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
import { PanelAction, PanelHeader } from '@/shared/ui/panel';
import { panelSurface } from '@/shared/ui/panel-styles';
import { StepResult, type InboxTarget } from '@/widgets/pipeline-step-result';

type Props = {
  run: PipelineRun;
  steps: PipelineStepRecord[];
  selectedIndex: number | null;
  connected: boolean;
  pending: boolean;
  error: string;
  api: Pick<PipelinesApi, 'readEvidence'>;
  onSelectStep: (index: number) => void;
  onStop: () => void;
  onResume: () => void;
  onConfirmAction: (stepId: string) => void;
  onClose: () => void;
  onInbox: (target: InboxTarget) => void;
  onSession: (key: string) => void;
};

const SECOND_MS = 1000;

const focusSibling = (event: KeyboardEvent<HTMLButtonElement>) => {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  const chips = [
    ...(event.currentTarget
      .closest('[data-pipeline-steps]')
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

const currentStepIndex = (run: PipelineRun, records: PipelineStepRecord[]) =>
  run.currentStepIndex ??
  pipelineSteps(run, records).findLast(step => step.state !== 'pending')
    ?.index ??
  0;

export default function PipelinePanel({
  run,
  steps,
  selectedIndex,
  connected,
  pending,
  error,
  api,
  onSelectStep,
  onStop,
  onResume,
  onConfirmAction,
  onClose,
  onInbox,
  onSession,
}: Props) {
  const now = useNow(SECOND_MS);
  const closeButton = useRef<HTMLButtonElement>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    closeButton.current?.focus();
    const escape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(
          event.target instanceof Element &&
          event.target.closest('[role="dialog"]')
        )
      ) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  const views = pipelineSteps(run, steps);
  const phases = pipelinePhases(views);
  const index = selectedIndex ?? currentStepIndex(run, steps);
  const selected = views[index];
  const current =
    run.currentStepIndex === null ? undefined : views[run.currentStepIndex];
  const uncertain =
    current?.state === 'uncertain' && canResumeRun(run) ? current : undefined;
  const actionsDisabled = !connected || pending;
  const chip = (step: PipelineStepView) => {
    const duration = stepDuration(step, now);
    const label = [
      step.definition.name,
      stepStateLabels[step.state],
      step.attempts > 1 ? `attempt ${step.attempts}` : '',
      duration,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <li key={step.index} className="min-w-0">
        <button
          type="button"
          data-step-chip
          data-step-state={step.state}
          aria-label={label}
          aria-pressed={index === step.index}
          title={label}
          onKeyDown={focusSibling}
          onClick={() => onSelectStep(step.index)}
          className={cn(
            'inline-flex h-6 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-foreground transition-colors duration-100 outline-none',
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
      id="pipeline-panel"
      aria-label="Pipeline"
      data-run-id={run.id}
      data-run-status={run.status}
      className={cn(
        panelSurface,
        'min-[1200px]:w-[380px] min-[1600px]:w-[440px]',
      )}
    >
      <PanelHeader
        icon={Workflow}
        title={run.pipeline.name}
        meta={runStatusLabel(run.status)}
      >
        <PanelAction
          ref={closeButton}
          aria-label="Close pipeline"
          onClick={onClose}
        >
          <X className="size-4" />
        </PanelAction>
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-2.5 border-b px-3 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-2xs font-medium',
                toneText[runStatusTones[run.status]],
              )}
            >
              {runStatusLabel(run.status)}
            </span>
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={run.specPath}
            >
              {run.specTitle}
            </span>
          </div>
          {run.attention && (
            <p className="text-xs leading-5 text-warning-foreground [overflow-wrap:anywhere]">
              {run.attention}
            </p>
          )}
          {uncertain?.record && (
            <div className="space-y-2">
              <p className="text-xs leading-5 text-muted-foreground">
                {uncertain.definition.name} may already have run. Check its
                effect, then run it again or skip it as already done.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={actionsDisabled}
                  onClick={onResume}
                >
                  <RotateCcw />
                  Run it again
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={actionsDisabled}
                  onClick={() => onConfirmAction(uncertain.record!.id)}
                >
                  <Check />
                  It already ran
                </Button>
              </div>
            </div>
          )}
          {(isRunActive(run) || (canResumeRun(run) && !uncertain)) && (
            <div className="flex flex-wrap gap-1.5">
              {canResumeRun(run) && !uncertain && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={actionsDisabled}
                  onClick={onResume}
                >
                  <Play />
                  Resume
                </Button>
              )}
              {isRunActive(run) && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={actionsDisabled}
                  onClick={onStop}
                >
                  <Square className="fill-current" />
                  Stop pipeline
                </Button>
              )}
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
        </div>
        <div data-pipeline-steps className="space-y-2 border-b px-3 py-3">
          {phases.map(group => (
            <div key={group.phase} className="space-y-1">
              <p className="text-2xs text-muted-foreground">
                {phaseLabels[group.phase]}
              </p>
              <ul
                role="list"
                aria-label={`${phaseLabels[group.phase]} steps`}
                className="-mx-1.5 flex flex-wrap gap-0.5"
              >
                {group.steps.map(chip)}
              </ul>
            </div>
          ))}
        </div>
        {selected && (
          <div className="space-y-3 px-3 py-3">
            <h3 className="text-[13px] font-semibold">
              {selected.definition.name}
            </h3>
            <StepResult
              key={`${run.id}:${index}`}
              run={run}
              steps={steps}
              index={index}
              api={api}
              onInbox={onInbox}
              onSession={onSession}
            />
          </div>
        )}
      </div>
    </section>
  );
}
