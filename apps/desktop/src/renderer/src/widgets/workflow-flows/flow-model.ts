import {
  pendingStageQuestion,
  type DesktopSession,
  type DesktopWorkflowRun,
  type DesktopWorkflowStepRecord,
} from '@nesvo/contracts';
import { sessionStatusLabel } from '@/entities/session';
import {
  canResumeRun,
  isRunActive,
  latestAttempts,
  runStatusLabel,
  runStatusTones,
  stepStateLabels,
  stepStateTones,
} from '@/entities/workflow';
import type { StatusDotTone, StatusDotVariant } from '@/shared/ui/status-dot';
import { entityKey, hostKey } from '@/shared/lib/host-key';

type LiveRun = {
  run: DesktopWorkflowRun;
  session: DesktopSession;
  current: number[];
  records: Map<number, DesktopWorkflowStepRecord>;
};

export type FlowRow = {
  session: DesktopSession;
  depth: number;
  detail?: string;
  state: string;
  tone: StatusDotTone;
  variant: StatusDotVariant;
  startedAt: string;
  finishedAt: string | null;
};

export type WorkflowFlow = {
  id: string;
  run: DesktopWorkflowRun;
  rows: Map<number | null, FlowRow[]>;
};

const isLive = (run: DesktopWorkflowRun) =>
  isRunActive(run) || canResumeRun(run);

const onStep = (step: DesktopWorkflowStepRecord) =>
  step.state === 'running' || step.state === 'awaiting-human';

function currentSteps(run: DesktopWorkflowRun, records: LiveRun['records']) {
  if (run.status === 'implementing' || run.status === 'fixing') return [];
  const current = [...records.values()]
    .filter(
      step =>
        step.phase === run.phase &&
        (onStep(step) ||
          (run.status === 'needs-attention' &&
            (step.state === 'blocked' || step.state === 'uncertain'))),
    )
    .map(step => step.index);
  return current.length || run.currentStepIndex === null
    ? current
    : [run.currentStepIndex];
}

export function flowCounts(rows: FlowRow[]) {
  const sessions = new Map(
    rows.map(({ session }) => [entityKey(session), session]),
  );
  const agents = [...sessions.values()].filter(
    session => session.status === 'running' || session.status === 'stopping',
  ).length;
  return `${sessions.size} ${sessions.size === 1 ? 'session' : 'sessions'} · ${agents} ${agents === 1 ? 'agent' : 'agents'}`;
}

function flowRow(
  { run, session }: LiveRun,
  step: DesktopWorkflowStepRecord | null,
  depth: number,
  detail?: string,
): FlowRow {
  const waiting =
    sessionStatusLabel(session) === 'Needs approval' ||
    session.plan?.status === 'plan-ready' ||
    !!pendingStageQuestion(session);
  const stepStatus =
    step &&
    (isRunActive(run) ||
      (run.status === 'needs-attention' &&
        (step.state === 'error' || step.state === 'failed')));
  const tone = waiting
    ? 'warning'
    : stepStatus
      ? stepStateTones[step.state]
      : runStatusTones[run.status];
  const state = waiting
    ? 'Waiting for you'
    : stepStatus
      ? stepStateLabels[step.state]
      : runStatusLabel(run.status);
  return {
    session,
    depth,
    detail,
    state,
    tone: tone === 'muted' ? 'neutral' : tone,
    variant: tone === 'info' ? 'spinner' : 'solid',
    startedAt: step?.startedAt ?? step?.updatedAt ?? run.updatedAt,
    finishedAt: step?.result?.finishedAt ?? run.finishedAt,
  };
}

export function workflowFlows(
  sessions: DesktopSession[],
  runs: DesktopWorkflowRun[],
  steps: DesktopWorkflowStepRecord[],
): WorkflowFlow[] {
  const visible = new Map(
    sessions
      .filter(session => !session.archivedAt)
      .map(session => [entityKey(session), session]),
  );
  const stepsByRun = new Map<string, DesktopWorkflowStepRecord[]>();
  for (const step of steps) {
    const key = hostKey(step.runId, step.hostId);
    const records = stepsByRun.get(key) ?? [];
    records.push(step);
    stepsByRun.set(key, records);
  }
  const listed = runs.flatMap(run => {
    const session =
      run.sessionId && visible.get(hostKey(run.sessionId, run.hostId));
    if (!session) return [];
    const records = latestAttempts(stepsByRun.get(entityKey(run)) ?? []);
    return [{ run, session, records, current: currentSteps(run, records) }];
  });
  const byRunId = new Map(listed.map(item => [entityKey(item.run), item]));
  const children = new Map<string, LiveRun[]>();
  for (const item of listed) {
    const { run } = item;
    if (!run.parent) continue;
    const parent = byRunId.get(hostKey(run.parent.runId, run.hostId));
    if (!parent || !isLive(parent.run)) continue;
    const spawner = parent.current
      .map(index => parent.records.get(index))
      .find(step => step?.id === run.parent?.stepId);
    if (!spawner) continue;
    const key = entityKey(spawner);
    const siblings = children.get(key) ?? [];
    siblings.push(item);
    children.set(key, siblings);
  }

  const childRows = (
    step: DesktopWorkflowStepRecord,
    depth: number,
  ): FlowRow[] =>
    (children.get(entityKey(step)) ?? [])
      .toSorted(
        (left, right) =>
          (left.run.parent?.index ?? 0) - (right.run.parent?.index ?? 0),
      )
      .flatMap(item => {
        const names = item.current
          .map(index => item.run.workflow.steps[index]?.name)
          .filter(Boolean);
        const detail = `${item.run.workflow.name} · ${names.join(', ') || runStatusLabel(item.run.status)}`;
        const ownStep = item.records.get(item.current[0] ?? -1) ?? null;
        return [
          {
            ...flowRow(item, ownStep, depth, detail),
            startedAt: item.run.createdAt,
            finishedAt: item.run.finishedAt,
          },
          ...item.current.flatMap(index => {
            const record = item.records.get(index);
            return record ? childRows(record, depth + 1) : [];
          }),
        ];
      });

  const flows = new Map<string, WorkflowFlow>();
  for (const item of listed) {
    const { run } = item;
    if (!isLive(run)) continue;
    const id = JSON.stringify([
      run.hostId,
      run.projectRoot,
      run.workflow.name,
      run.workflow.source.contentHash,
      ...run.workflow.steps.map(step => step.source.contentHash),
    ]);
    const flow = flows.get(id) ?? {
      id,
      run,
      rows: new Map<number | null, FlowRow[]>(),
    };
    const indices = item.current.length > 0 ? item.current : [null];
    for (const index of indices) {
      const step = index === null ? null : (item.records.get(index) ?? null);
      const rows = flow.rows.get(index) ?? [];
      rows.push(flowRow(item, step, 0));
      if (step) {
        const agent =
          step.sessionId && visible.get(hostKey(step.sessionId, step.hostId));
        if (agent && agent.id !== item.session.id && onStep(step)) {
          rows.push(flowRow({ ...item, session: agent }, step, 1));
        }
        rows.push(...childRows(step, 1));
      }
      flow.rows.set(index, rows);
    }
    flows.set(id, flow);
  }
  return [...flows.values()].sort((left, right) =>
    left.run.workflow.name.localeCompare(right.run.workflow.name),
  );
}
