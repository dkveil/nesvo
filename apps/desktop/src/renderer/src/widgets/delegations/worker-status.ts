import { delegationStatusLabels, type Session } from '@/entities/session';
import {
  subsessionStatus,
  type SubsessionStatus,
} from '@/entities/session/subsession-status';

type Delegation = Session['delegations'][number];

const delegationStatuses: Record<
  Delegation['status'],
  Omit<SubsessionStatus, 'state'>
> = {
  pending: { tone: 'warning', variant: 'solid', attention: true },
  'plan-ready': { tone: 'warning', variant: 'solid', attention: true },
  planning: { tone: 'info', variant: 'spinner', attention: false },
  running: { tone: 'info', variant: 'spinner', attention: false },
  completed: { tone: 'success', variant: 'solid', attention: false },
  declined: { tone: 'neutral', variant: 'solid', attention: false },
  stopped: { tone: 'neutral', variant: 'solid', attention: false },
  failed: { tone: 'error', variant: 'solid', attention: true },
  interrupted: { tone: 'error', variant: 'solid', attention: true },
};

const decidedByOperator = new Set<Delegation['status']>([
  'pending',
  'plan-ready',
  'declined',
]);

export function workerStatus(
  delegation: Delegation | undefined,
  child: Session | undefined,
): SubsessionStatus {
  if (child && (!delegation || !decidedByOperator.has(delegation.status)))
    return subsessionStatus(child);
  const status = delegation?.status ?? 'stopped';
  return {
    ...delegationStatuses[status],
    state:
      status === 'pending' ? 'Needs approval' : delegationStatusLabels[status],
  };
}
