import type {
  DesktopPipelineRun,
  DesktopPipelineStepRecord,
  PipelineRunStatus,
  PipelineStepState,
  ResolvedStep,
  StepPhase,
} from '@nesvo/contracts';
import { sessionStatusLabel, type Session } from '@/entities/session';

export type {
  DefinitionCatalog,
  DefinitionIssue,
  DesktopPipelineRun as PipelineRun,
  DesktopPipelineStepRecord as PipelineStepRecord,
  Evidence,
  PipelineEvidence,
  PipelineRunStatus,
  PipelineStepState,
  ResolvedPipeline,
  ResolvedStep,
  StepPhase,
  StepResult,
  TaskSpecSummary,
} from '@nesvo/contracts';

export type PipelineTone = 'success' | 'error' | 'warning' | 'info' | 'muted';

export const toneText: Record<PipelineTone, string> = {
  success: 'text-success-foreground',
  error: 'text-error-foreground',
  warning: 'text-warning-foreground',
  info: 'text-info-foreground',
  muted: 'text-muted-foreground',
};

export const phaseLabels: Record<StepPhase, string> = {
  plan: 'Plan',
  'pre-done': 'Before done',
  'pre-push': 'Before push',
};

export const phaseOrder: StepPhase[] = ['plan', 'pre-done', 'pre-push'];

export type StepDisplayState = PipelineStepState | 'unreached';

export const stepStateLabels: Record<StepDisplayState, string> = {
  pending: 'Pending',
  running: 'Running',
  'awaiting-human': 'Waiting for you',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  done: 'Done',
  error: 'Error',
  skipped: 'Skipped',
  interrupted: 'Interrupted',
  uncertain: 'May have run',
  unreached: 'Not reached',
};

export const stepStateTones: Record<StepDisplayState, PipelineTone> = {
  pending: 'muted',
  running: 'info',
  'awaiting-human': 'warning',
  passed: 'success',
  failed: 'error',
  blocked: 'warning',
  done: 'success',
  error: 'error',
  skipped: 'muted',
  interrupted: 'muted',
  uncertain: 'warning',
  unreached: 'muted',
};

const runStatusLabels: Record<PipelineRunStatus, string> = {
  pending: 'Queued',
  planning: 'Planning',
  implementing: 'Implementing',
  checking: 'Checking',
  'awaiting-human': 'Waiting for you',
  fixing: 'Fixing',
  passed: 'Passed',
  failed: 'Failed',
  rejected: 'Rejected',
  'needs-attention': 'Needs attention',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};

export const runStatusTones: Record<PipelineRunStatus, PipelineTone> = {
  pending: 'muted',
  planning: 'info',
  implementing: 'info',
  checking: 'info',
  'awaiting-human': 'warning',
  fixing: 'info',
  passed: 'success',
  failed: 'error',
  rejected: 'error',
  'needs-attention': 'warning',
  stopped: 'muted',
  interrupted: 'muted',
};

export const runStatusLabel = (status: PipelineRunStatus) =>
  runStatusLabels[status];

const activeRunStatuses: PipelineRunStatus[] = [
  'pending',
  'planning',
  'implementing',
  'checking',
  'awaiting-human',
  'fixing',
];

export const showsRunStatus = (
  session: Session,
  run: DesktopPipelineRun | undefined,
): run is DesktopPipelineRun =>
  !!run &&
  !session.pipelineStepId &&
  session.status !== 'failed' &&
  sessionStatusLabel(session) !== 'Needs approval';

export const isRunActive = (run: DesktopPipelineRun) =>
  activeRunStatuses.includes(run.status);

export const canResumeRun = (run: DesktopPipelineRun) =>
  run.status === 'needs-attention' || run.status === 'interrupted';

export type PipelineStepView = {
  index: number;
  definition: ResolvedStep;
  record: DesktopPipelineStepRecord | null;
  state: PipelineStepState;
  attempts: number;
};

export type PipelinePhaseView = {
  phase: StepPhase;
  steps: PipelineStepView[];
};

export const latestAttempts = (records: DesktopPipelineStepRecord[]) => {
  const latest = new Map<number, DesktopPipelineStepRecord>();
  for (const record of records) {
    const current = latest.get(record.index);
    if (!current || record.attempt > current.attempt)
      latest.set(record.index, record);
  }
  return latest;
};

export const pipelineSteps = (
  run: DesktopPipelineRun,
  records: DesktopPipelineStepRecord[],
): PipelineStepView[] => {
  const latest = latestAttempts(records);
  return run.pipeline.steps.map((definition, index) => {
    const record = latest.get(index) ?? null;
    return {
      index,
      definition,
      record,
      state: record?.state ?? 'pending',
      attempts: record ? Math.max(record.attempt, 1) : 0,
    };
  });
};

export const pipelinePhases = (steps: PipelineStepView[]) =>
  phaseOrder
    .map(phase => ({
      phase,
      steps: steps.filter(step => step.definition.phase === phase),
    }))
    .filter(group => group.steps.length > 0);

const SECOND_MS = 1000;
const SECONDS_PER_MINUTE = 60;

export const formatDuration = (milliseconds: number) => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  if (milliseconds < SECOND_MS) return `${Math.round(milliseconds)}ms`;
  const totalSeconds = Math.round(milliseconds / SECOND_MS);
  if (totalSeconds < SECONDS_PER_MINUTE) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
};

export const stepDuration = (step: PipelineStepView, now: number) => {
  if (step.record?.result) return formatDuration(step.record.result.durationMs);
  if (step.state === 'running' && step.record?.startedAt)
    return formatDuration(now - Date.parse(step.record.startedAt));
  return '';
};

const completedStates: PipelineStepState[] = ['passed', 'done', 'skipped'];

const phaseStatePriority: PipelineStepState[] = [
  'failed',
  'error',
  'uncertain',
  'blocked',
  'awaiting-human',
  'running',
  'interrupted',
];

export const isStepComplete = (step: PipelineStepView) =>
  completedStates.includes(step.state);

export const phaseState = (steps: PipelineStepView[]): PipelineStepState => {
  const urgent = phaseStatePriority.find(state =>
    steps.some(step => step.state === state),
  );
  if (urgent) return urgent;
  return steps.every(isStepComplete) ? 'passed' : 'pending';
};

export const phaseProgress = (steps: PipelineStepView[]) =>
  `${steps.filter(isStepComplete).length}/${steps.length}`;
