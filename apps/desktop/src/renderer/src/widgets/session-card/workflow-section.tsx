import { useState } from 'react';
import type { WorkflowsApi } from '@nesvo/contracts';
import { ChevronDown } from 'lucide-react';
import { cn } from 'cn';
import {
  canResumeRun,
  isStepComplete,
  phaseLabels,
  phaseProgress,
  phaseState,
  workflowPhases,
  workflowSteps,
  runStatusLabel,
  runStatusTones,
  stepStateLabels,
  toneText,
  type WorkflowPhaseView,
  type WorkflowRun,
  type WorkflowStepRecord,
  type StepPhase,
} from '@/entities/workflow';
import { StepStateIcon } from '@/entities/workflow/step-state-icon';
import { useNow } from '@/shared/lib/use-now';
import type { InboxTarget } from '@/widgets/workflow-step-result';
import {
  cardRowAction,
  cardSection,
  cardSectionHeader,
} from '@/shared/ui/card-row-styles';
import { WorkflowMenu } from './workflow-menu';
import { WorkflowStepRow } from './workflow-step-row';

type Props = {
  run: WorkflowRun;
  steps: WorkflowStepRecord[];
  connected: boolean;
  pending: boolean;
  error: string;
  api: Pick<WorkflowsApi, 'readEvidence'>;
  onStop: () => void;
  onResume: () => void;
  onConfirmAction: (stepId: string) => void;
  onInbox: (target: InboxTarget) => void;
  onSession: (key: string) => void;
};

const SECOND_MS = 1000;

const initialPhase = (run: WorkflowRun, phases: WorkflowPhaseView[]) =>
  (run.currentStepIndex === null
    ? undefined
    : phases.find(group =>
        group.steps.some(step => step.index === run.currentStepIndex),
      )?.phase) ??
  phases.find(group => !group.steps.every(isStepComplete))?.phase;

export function WorkflowSection({
  run,
  steps,
  connected,
  pending,
  error,
  api,
  onStop,
  onResume,
  onConfirmAction,
  onInbox,
  onSession,
}: Props) {
  const now = useNow(SECOND_MS);
  const views = workflowSteps(run, steps);
  const phases = workflowPhases(views);
  const [expanded, setExpanded] = useState<StepPhase[]>(() => {
    const phase = initialPhase(run, phases);
    return phase ? [phase] : [];
  });
  const [openStep, setOpenStep] = useState<number | null>(null);
  const status = runStatusLabel(run.status);
  const current =
    run.currentStepIndex === null ? undefined : views[run.currentStepIndex];
  const uncertain =
    current?.state === 'uncertain' && canResumeRun(run) ? current : undefined;
  const toggle = (phase: StepPhase) => {
    if (
      expanded.includes(phase) &&
      views[openStep ?? -1]?.definition.phase === phase
    )
      setOpenStep(null);
    setExpanded(previous =>
      previous.includes(phase)
        ? previous.filter(item => item !== phase)
        : [...previous, phase],
    );
  };
  return (
    <section
      aria-labelledby="session-card-workflow"
      data-run-id={run.id}
      data-run-status={run.status}
      className={cardSection}
    >
      <div className={cardSectionHeader}>
        <h2
          id="session-card-workflow"
          className="min-w-0 truncate font-normal"
          title={run.workflow.name}
        >
          Workflow ·{' '}
          <span className={toneText[runStatusTones[run.status]]}>{status}</span>
        </h2>
        <WorkflowMenu
          run={run}
          views={views}
          disabled={!connected || pending}
          onStop={onStop}
          onResume={onResume}
          onConfirmAction={onConfirmAction}
        />
      </div>
      {run.attention && (
        <p className="px-2.5 pb-1.5 text-2xs leading-4 text-warning-foreground [overflow-wrap:anywhere]">
          {run.attention}
        </p>
      )}
      {uncertain && (
        <p className="px-2.5 pb-1.5 text-2xs leading-4 text-muted-foreground">
          {uncertain.definition.name} may already have run. Check its effect,
          then choose It already ran or Run it again from the actions menu.
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="px-2.5 pb-1.5 text-2xs leading-4 text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <ul role="list" aria-label="Workflow phases" className="space-y-px">
        {phases.map(group => {
          const open = expanded.includes(group.phase);
          const label = phaseLabels[group.phase];
          const state = phaseState(group.steps);
          const progress = phaseProgress(group.steps);
          return (
            <li key={group.phase}>
              <button
                type="button"
                data-card-row
                data-phase={group.phase}
                data-phase-state={state}
                aria-expanded={open}
                aria-controls={
                  open ? `session-card-phase-${group.phase}` : undefined
                }
                aria-label={`${label}, ${stepStateLabels[state]}, ${progress} complete`}
                onClick={() => toggle(group.phase)}
                className={cardRowAction}
              >
                <StepStateIcon state={state} className="size-4" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                  {progress}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    'size-3.5 shrink-0 text-muted-foreground transition-transform duration-150',
                    open && 'rotate-180',
                  )}
                />
              </button>
              {open && (
                <ul
                  id={`session-card-phase-${group.phase}`}
                  role="list"
                  aria-label={`${label} steps`}
                  className="space-y-px"
                >
                  {group.steps.map(step => (
                    <WorkflowStepRow
                      key={step.index}
                      run={run}
                      steps={steps}
                      step={step}
                      now={now}
                      open={openStep === step.index}
                      api={api}
                      onOpenChange={next =>
                        setOpenStep(next ? step.index : null)
                      }
                      onInbox={onInbox}
                      onSession={onSession}
                    />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
