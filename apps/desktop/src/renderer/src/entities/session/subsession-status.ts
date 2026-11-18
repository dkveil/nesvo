import type { StatusDotTone, StatusDotVariant } from '@/shared/ui/status-dot';
import { sessionStatusLabel, type Session } from './index';

export type SubsessionStatus = {
  tone: StatusDotTone;
  variant: StatusDotVariant;
  state: string;
  attention: boolean;
};

const attentionStates = new Set(['Needs approval', 'Plan ready']);

const failureStatuses = new Set<Session['status']>(['failed', 'interrupted']);

export function subsessionStatus(
  session: Session,
  stopping = false,
): SubsessionStatus {
  const state = stopping ? 'Stopping…' : sessionStatusLabel(session);
  if (attentionStates.has(state))
    return { tone: 'warning', variant: 'solid', state, attention: true };
  if (failureStatuses.has(session.status))
    return { tone: 'error', variant: 'solid', state, attention: true };
  if (stopping || session.status === 'running' || session.status === 'stopping')
    return { tone: 'info', variant: 'spinner', state, attention: false };
  if (session.status === 'completed')
    return { tone: 'success', variant: 'solid', state, attention: false };
  return { tone: 'neutral', variant: 'solid', state, attention: false };
}

export const statusTextTones: Partial<Record<StatusDotTone, string>> = {
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
};
