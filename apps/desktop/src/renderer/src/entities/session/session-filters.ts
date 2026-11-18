import type {
  DesktopReview,
  DesktopSession as Session,
  DesktopWorkflowRun,
  WorkflowRunStatus,
} from '@nesvo/contracts';
import { entityKey, hostKey } from '@/shared/lib/host-key';

export const sessionFilters = ['all', 'needs-me', 'running', 'failed'] as const;

export type SessionFilter = (typeof sessionFilters)[number];

export type SessionFilterKeys = Record<
  Exclude<SessionFilter, 'all'>,
  Set<string>
>;

export const sessionFilterLabels: Record<SessionFilter, string> = {
  all: 'All',
  'needs-me': 'Needs me',
  running: 'Running',
  failed: 'Failed',
};

const attentionRuns: WorkflowRunStatus[] = [
  'awaiting-human',
  'needs-attention',
];
const workingRuns: WorkflowRunStatus[] = [
  'pending',
  'planning',
  'implementing',
  'checking',
  'fixing',
];
const failedRuns: WorkflowRunStatus[] = ['failed', 'rejected'];

const runKey = (run: Pick<DesktopWorkflowRun, 'id' | 'hostId'>) =>
  hostKey(run.id, run.hostId);

const waitsForDecision = (session: Session) =>
  (session.status === 'running' && session.pendingApprovals.length > 0) ||
  session.delegations.some(
    delegation =>
      (delegation.status === 'pending' &&
        session.status === 'running' &&
        delegation.runId === session.runId) ||
      delegation.status === 'plan-ready',
  );

export function sessionFilterKeys(
  sessions: Session[],
  reviews: Pick<DesktopReview, 'sessionId' | 'hostId' | 'status'>[],
  runs: Pick<DesktopWorkflowRun, 'id' | 'hostId' | 'status'>[],
): SessionFilterKeys {
  const reviewed = new Set(
    reviews
      .filter(review => review.status === 'pending')
      .map(review => hostKey(review.sessionId, review.hostId)),
  );
  const runStatus = new Map(runs.map(run => [runKey(run), run.status]));
  const statusOfRun = (session: Session) =>
    session.workflowRunId
      ? runStatus.get(hostKey(session.workflowRunId, session.hostId))
      : undefined;
  const keys: SessionFilterKeys = {
    'needs-me': new Set(),
    running: new Set(),
    failed: new Set(),
  };
  for (const session of sessions) {
    if (session.archivedAt) continue;
    const key = entityKey(session);
    const run = statusOfRun(session);
    if (
      waitsForDecision(session) ||
      reviewed.has(key) ||
      (!!run && attentionRuns.includes(run))
    )
      keys['needs-me'].add(key);
    if (
      session.status === 'running' ||
      session.status === 'stopping' ||
      (!!run && workingRuns.includes(run))
    )
      keys.running.add(key);
    if (
      session.status === 'failed' ||
      session.status === 'interrupted' ||
      (!!run && failedRuns.includes(run))
    )
      keys.failed.add(key);
  }
  return keys;
}
