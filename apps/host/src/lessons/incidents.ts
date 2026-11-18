import { randomUUID } from 'node:crypto';
import {
  lessonLimits,
  type Delegation,
  type LessonIncident,
  type LessonIncidentKind,
  type Session,
  type SessionStageRecord,
  type WorkflowRun,
  type WorkflowStepRecord,
} from '@nesvo/contracts';
import { isInactivityFailure } from '../providers/inactivity';
import {
  maskProbeText,
  personalPatterns,
  secretPatterns,
} from '../workflows/steps/sensitive-patterns';

export type IncidentDraft = {
  fingerprint: string;
  incident: LessonIncident;
};

export const PLAN_CORRECTION_THRESHOLD = 2;
const QUOTE_LENGTH = 400;
const FAILED_STEP_STATES: readonly WorkflowStepRecord['state'][] = [
  'failed',
  'error',
];
const REMARK_KINDS = [
  ['systemRemarks', 'System remark'],
  ['deadEnds', 'Dead end'],
] as const;

const bounded = (text: string, max: number) => {
  const masked = maskProbeText(text).replace(/\s+/g, ' ').trim();
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
};

const draft = (
  fingerprint: string,
  kind: LessonIncidentKind,
  at: string,
  summary: string,
  details: readonly string[],
  links: Partial<
    Pick<
      LessonIncident,
      | 'sessionId'
      | 'runId'
      | 'workflowRunId'
      | 'workflowStepId'
      | 'workflow'
      | 'step'
      | 'directory'
      | 'quote'
    >
  >,
): IncidentDraft => ({
  fingerprint,
  incident: {
    id: randomUUID(),
    kind,
    at,
    summary: bounded(summary, lessonLimits.incidentSummary),
    details: details
      .map(detail => bounded(detail, lessonLimits.incidentDetail))
      .filter(Boolean)
      .slice(0, lessonLimits.incidentDetails),
    sessionId: links.sessionId ?? null,
    runId: links.runId ?? null,
    workflowRunId: links.workflowRunId ?? null,
    workflowStepId: links.workflowStepId ?? null,
    workflow: links.workflow ?? null,
    step: links.step ?? null,
    directory: links.directory ?? null,
    quote: links.quote ? bounded(links.quote, QUOTE_LENGTH) : null,
    proposedAt: null,
  },
});

const sessionLinks = (session: Session, runId: string | null) => ({
  sessionId: session.id,
  runId,
  workflowRunId: session.workflowRunId,
  workflowStepId: session.workflowStepId,
  directory: session.worktree?.projectDirectory ?? session.directory,
});

const quotedTitle = (session: Pick<Session, 'title'>) =>
  JSON.stringify(session.title.slice(0, 80));

export const finishedRunIncidents = (
  session: Session,
  runId: string,
  costNormUsd: number | null,
  now: Date,
): IncidentDraft[] => {
  const at = now.toISOString();
  const drafts: IncidentDraft[] = [];
  if (session.status === 'failed' && isInactivityFailure(session.error))
    drafts.push(
      draft(
        `session-stuck:${runId}`,
        'session-stuck',
        at,
        `${session.provider} session ${quotedTitle(session)} stopped because the provider was silent past the inactivity limit.`,
        [session.activity ? `Last activity: ${session.activity}` : ''],
        sessionLinks(session, runId),
      ),
    );
  const cost = session.messages.find(
    message => message.runId === runId && message.author === 'agent',
  )?.usage?.costUsd;
  if (costNormUsd !== null && cost != null && cost > costNormUsd)
    drafts.push(
      draft(
        `cost-over-norm:${runId}`,
        'cost-over-norm',
        at,
        `A turn in ${quotedTitle(session)} cost ${cost.toFixed(2)} USD, above the ${costNormUsd.toFixed(2)} USD norm.`,
        [`Model ${session.actualModel ?? session.model}, mode ${session.mode}.`],
        sessionLinks(session, runId),
      ),
    );
  return drafts;
};

const correctionsSinceAccept = (records: readonly SessionStageRecord[]) => {
  let corrections = 0;
  for (const record of records)
    if (record.kind === 'plan-decision')
      corrections = record.decision === 'correct' ? corrections + 1 : 0;
  return corrections;
};

export const stageRecordIncidents = (
  session: Session,
  records: readonly SessionStageRecord[],
): IncidentDraft[] => {
  const drafts: IncidentDraft[] = [];
  for (const record of records) {
    if (record.kind === 'plan-decision' && record.decision === 'decline')
      drafts.push(
        draft(
          `plan-rejected:${record.planId}`,
          'plan-rejected',
          record.at,
          `The owner rejected the plan of ${quotedTitle(session)}.`,
          record.text ? [`Reason: ${record.text}`] : [],
          {
            ...sessionLinks(session, session.plan?.runId ?? null),
            quote: record.text,
          },
        ),
      );
    if (record.kind === 'plan-decision' && record.decision === 'correct') {
      const position = session.stageRecords.findIndex(
        item => item.id === record.id,
      );
      const corrections = correctionsSinceAccept(
        position === -1
          ? session.stageRecords
          : session.stageRecords.slice(0, position + 1),
      );
      if (corrections > PLAN_CORRECTION_THRESHOLD)
        drafts.push(
          draft(
            `plan-corrected:${record.planId}`,
            'plan-corrected',
            record.at,
            `The plan of ${quotedTitle(session)} needed ${corrections} corrections.`,
            record.text ? [`Latest correction: ${record.text}`] : [],
            {
              ...sessionLinks(session, session.plan?.runId ?? null),
              quote: record.text,
            },
          ),
        );
    }
    if (record.kind === 'report') {
      const notes = REMARK_KINDS.flatMap(([key, label]) =>
        record.report.notes[key].map(note => `${label}: ${note}`),
      );
      if (notes.length)
        drafts.push(
          draft(
            `stage-remarks:${record.id}`,
            'stage-remarks',
            record.at,
            `The stage report of ${quotedTitle(session)} has ${notes.length} system remark${notes.length === 1 ? '' : 's'} or dead end${notes.length === 1 ? '' : 's'}.`,
            notes,
            sessionLinks(session, record.runId),
          ),
        );
    }
  }
  return drafts;
};

export const workerPlanIncident = (
  parent: Session,
  delegation: Delegation,
  decision: 'accept' | 'correct' | 'decline',
  text: string | null,
  now: Date,
): IncidentDraft | null => {
  const at = now.toISOString();
  const links = {
    ...sessionLinks(parent, delegation.runId),
    sessionId: delegation.childSessionId ?? parent.id,
    runId: delegation.childRunId ?? null,
  };
  if (decision === 'decline')
    return draft(
      `worker-plan-rejected:${delegation.id}`,
      'plan-rejected',
      at,
      `The owner rejected the plan of worker ${JSON.stringify(delegation.title.slice(0, 80))}.`,
      text ? [`Reason: ${text}`] : [],
      { ...links, quote: text },
    );
  if (decision === 'correct' && delegation.planRound > PLAN_CORRECTION_THRESHOLD)
    return draft(
      `worker-plan-corrected:${delegation.id}`,
      'plan-corrected',
      at,
      `The plan of worker ${JSON.stringify(delegation.title.slice(0, 80))} needed ${delegation.planRound} corrections.`,
      text ? [`Latest correction: ${text}`] : [],
      { ...links, quote: text },
    );
  return null;
};

const labelsOf = (patterns: readonly { label: string }[]) =>
  new Set(patterns.map(pattern => pattern.label));
const SECRET_LABELS = labelsOf(secretPatterns);
const PERSONAL_LABELS = labelsOf(personalPatterns);

const sensitiveLabel = (text: string) => {
  const match = /^(.+?) \[masked\] — /.exec(text);
  if (!match) return null;
  const label = match[1]!;
  if (SECRET_LABELS.has(label)) return { label, secret: true };
  if (PERSONAL_LABELS.has(label)) return { label, secret: false };
  return null;
};

export const workflowStepIncidents = (
  run: WorkflowRun,
  step: WorkflowStepRecord,
  now: Date,
): IncidentDraft[] => {
  const at = now.toISOString();
  const links = {
    sessionId: step.sessionId,
    runId: null,
    workflowRunId: run.id,
    workflowStepId: step.id,
    workflow: run.workflow.name,
    step: step.name,
    directory: run.projectRoot,
  };
  const drafts: IncidentDraft[] = [];
  const definition = run.workflow.steps[step.index];
  const retries = definition?.retries ?? 0;
  if (
    FAILED_STEP_STATES.includes(step.state) &&
    retries > 0 &&
    (step.retry ?? 0) >= retries
  )
    drafts.push(
      draft(
        `step-retries-exhausted:${run.id}:${step.index}:${step.iteration ?? 1}`,
        'step-retries-exhausted',
        at,
        `Step ${JSON.stringify(step.name)} of workflow ${JSON.stringify(run.workflow.name)} failed after ${retries + 1} attempts.`,
        step.result?.summary ? [`Last result: ${step.result.summary}`] : [],
        links,
      ),
    );
  if (step.type === 'probe' && step.result) {
    const found = step.result.evidence
      .map(item => (item.text ? sensitiveLabel(item.text) : null))
      .filter(item => item !== null);
    const secrets = found.filter(item => item.secret);
    const personal = found.filter(item => !item.secret);
    if (found.length)
      drafts.push(
        draft(
          `probe-sensitive-data:${step.id}`,
          'probe-sensitive-data',
          at,
          `Probe ${JSON.stringify(step.name)} in workflow ${JSON.stringify(run.workflow.name)} found ${secrets.length} secret and ${personal.length} personal-data signal${found.length === 1 ? '' : 's'} in the diff.`,
          [
            `Kinds: ${[...new Set(found.map(item => item.label))].join(', ')}. Values are never recorded.`,
          ],
          links,
        ),
      );
  }
  return drafts;
};
