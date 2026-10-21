import type { Session, SessionStatus, SessionStatusSource } from './session';

export function sessionReadinessLabel(readiness: Session['readiness']): string | undefined {
  if (readiness?.phase === 'starting') return 'Starting';
  if (readiness?.phase === 'timedOut') return 'Startup failed';
  return undefined;
}

export function statusNeedsAttention(
  status: SessionStatus,
  projection?: Session['currentAttention'],
): boolean {
  if (projection) return projection.priority > 0;
  return status === 'question' || status === 'blocked' || status === 'failed';
}

/** Activity reports terminal I/O, not an agent's internal progress. */
export function sessionStatusLabel(status: SessionStatus, source?: SessionStatusSource): string {
  if (source === 'activity' && status === 'working') return 'Open';
  if (source === 'activity' && status === 'idle') return 'Quiet';
  return {
    working: 'Working',
    idle: 'Idle',
    done: 'Done',
    blocked: 'Blocked',
    question: 'Question',
    failed: 'Failed',
    unknown: 'Unknown',
  }[status];
}

export function sessionStatusDetail(status: SessionStatus, source?: SessionStatusSource): string {
  if (source === 'activity')
    return status === 'working' ? 'Recently used terminal' : 'No agent work signal';
  if (source === 'screen') return 'Approximate state inferred from terminal content';
  if (source === 'hook') return 'State confirmed by an agent event';
  if (source === 'program') return 'State reported by the program in the terminal';
  if (source === 'process') return 'Process state on the computer';
  return 'No agent state information';
}
