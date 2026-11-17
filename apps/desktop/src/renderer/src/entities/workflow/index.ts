import type {
  DesktopWorkflowRun,
  DesktopWorkflowStepRecord,
  WorkflowRunStatus,
  WorkflowStepState,
  ResolvedStep,
  StepPhase,
} from '@nesvo/contracts';
import { sessionStatusLabel, type Session } from '@/entities/session';
import type { Tone as WorkflowTone } from '@/entities/status';

export type {
  DefinitionCatalog,
  DefinitionIssue,
  DesktopWorkflowRun as WorkflowRun,
  DesktopWorkflowStepRecord as WorkflowStepRecord,
  Evidence,
  WorkflowEvidence,
  WorkflowRunStatus,
  WorkflowStepState,
  ResolvedWorkflow,
  ResolvedStep,
  StepPhase,
  StepResult,
  TaskSpecSummary,
} from '@nesvo/contracts';

export { toneText, type Tone as WorkflowTone } from '@/entities/status';

export const phaseLabels: Record<StepPhase, string> = {
  plan: 'Plan',
  'pre-done': 'Before done',
  'pre-push': 'Before push',
};

export const phaseOrder: StepPhase[] = ['plan', 'pre-done', 'pre-push'];

export type StepDisplayState = WorkflowStepState | 'unreached';

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

export const stepStateTones: Record<StepDisplayState, WorkflowTone> = {
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

const runStatusLabels: Record<WorkflowRunStatus, string> = {
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

export const runStatusTones: Record<WorkflowRunStatus, WorkflowTone> = {
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

export const runStatusLabel = (status: WorkflowRunStatus) =>
  runStatusLabels[status];

const activeRunStatuses: WorkflowRunStatus[] = [
  'pending',
  'planning',
  'implementing',
  'checking',
  'awaiting-human',
  'fixing',
];

export const showsRunStatus = (
  session: Session,
  run: DesktopWorkflowRun | undefined,
): run is DesktopWorkflowRun =>
  !!run &&
  !session.workflowStepId &&
  session.status !== 'failed' &&
  sessionStatusLabel(session) !== 'Needs approval';

export const isRunActive = (run: DesktopWorkflowRun) =>
  activeRunStatuses.includes(run.status);

export const canResumeRun = (run: DesktopWorkflowRun) =>
  run.status === 'needs-attention' || run.status === 'interrupted';

export type WorkflowStepView = {
  index: number;
  definition: ResolvedStep;
  record: DesktopWorkflowStepRecord | null;
  state: WorkflowStepState;
  attempts: number;
};

export type WorkflowPhaseView = {
  phase: StepPhase;
  steps: WorkflowStepView[];
};

export const latestAttempts = (records: DesktopWorkflowStepRecord[]) => {
  const latest = new Map<number, DesktopWorkflowStepRecord>();
  for (const record of records) {
    const current = latest.get(record.index);
    if (!current || record.attempt > current.attempt)
      latest.set(record.index, record);
  }
  return latest;
};

export const workflowSteps = (
  run: DesktopWorkflowRun,
  records: DesktopWorkflowStepRecord[],
): WorkflowStepView[] => {
  const latest = latestAttempts(records);
  return run.workflow.steps.map((definition, index) => {
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

export const workflowPhases = (steps: WorkflowStepView[]) =>
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

export const stepDuration = (step: WorkflowStepView, now: number) => {
  if (step.record?.result) return formatDuration(step.record.result.durationMs);
  if (step.state === 'running' && step.record?.startedAt)
    return formatDuration(now - Date.parse(step.record.startedAt));
  return '';
};

const completedStates: WorkflowStepState[] = ['passed', 'done', 'skipped'];

const phaseStatePriority: WorkflowStepState[] = [
  'failed',
  'error',
  'uncertain',
  'blocked',
  'awaiting-human',
  'running',
  'interrupted',
];

export const isStepComplete = (step: WorkflowStepView) =>
  completedStates.includes(step.state);

export const phaseState = (steps: WorkflowStepView[]): WorkflowStepState => {
  const urgent = phaseStatePriority.find(state =>
    steps.some(step => step.state === state),
  );
  if (urgent) return urgent;
  return steps.every(isStepComplete) ? 'passed' : 'pending';
};

export const phaseProgress = (steps: WorkflowStepView[]) =>
  `${steps.filter(isStepComplete).length}/${steps.length}`;
