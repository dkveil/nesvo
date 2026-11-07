import {
  activityLimits,
  sessionActivitySchema,
  type Session,
  type SessionActivity,
} from '@nesvo/contracts';
import type { ProviderActivity } from '../providers/activity';

function markTruncated(session: Session, runId: string): void {
  session.activitiesTruncated = true;
  if (!session.activityTruncatedRunIds.includes(runId))
    session.activityTruncatedRunIds.push(runId);
  session.activityTruncatedRunIds = session.activityTruncatedRunIds.slice(
    -activityLimits.items,
  );
}

export function updateActivity(
  session: Session,
  input: ProviderActivity,
  evicted: Set<string>,
): boolean {
  const next = sessionActivitySchema.parse({ ...input, runId: session.runId });
  if (evicted.has(next.id)) return false;
  const previous = session.activities.find(
    item => item.runId === next.runId && item.id === next.id,
  );
  if (previous) {
    if (previous.status !== 'running' && next.status === 'running')
      return false;
    Object.assign(previous, next, {
      startedAt: previous.startedAt,
      status: previous.status === 'running' ? next.status : previous.status,
      completedAt: previous.completedAt ?? next.completedAt,
      detail: next.detail ?? previous.detail,
      output: next.output || previous.output,
      paths: next.paths.length ? next.paths : previous.paths,
      truncated: previous.truncated || next.truncated,
    });
    return true;
  }
  if (
    session.activities.filter(item => item.runId === next.runId).length >=
    activityLimits.perRun
  ) {
    const index = session.activities.findIndex(
      item => item.runId === next.runId,
    );
    const [removed] = session.activities.splice(index, 1);
    evicted.add(removed!.id);
    markTruncated(session, next.runId);
  }
  while (session.activities.length >= activityLimits.items) {
    const removed = session.activities.shift()!;
    if (removed.runId === next.runId) evicted.add(removed.id);
    markTruncated(session, removed.runId);
  }
  session.activities.push(next);
  return true;
}

export function finishActivities(
  session: Session,
  status: Session['status'],
): void {
  const completedAt = new Date().toISOString();
  for (const item of session.activities) {
    if (item.runId !== session.runId || item.status !== 'running') continue;
    const terminal: SessionActivity['status'] =
      status === 'stopped'
        ? 'stopped'
        : status === 'failed'
          ? 'failed'
          : 'interrupted';
    item.status = terminal;
    item.completedAt = completedAt;
  }
}
