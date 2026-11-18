import {
  listSubsessions,
  type DecideDelegationInput,
  type DecideWorkerPlanInput,
} from '@nesvo/contracts';
import { elapsedLabel } from '@/entities/activity';
import type { Session } from '@/entities/session';
import { cn } from '@/shared/lib/cn';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { infoPanelSurface } from '@/shared/ui/card-row-styles';
import { SectionLabel } from '@/shared/ui/section-label';
import { WorkerItem } from './worker-item';

type Props = {
  session: Session;
  children: Session[];
  enabled: boolean;
  pending: Record<string, boolean>;
  onDecision: (
    delegationId: string,
    decision: DecideDelegationInput['decision'],
  ) => void;
  onPlanDecision: (
    delegationId: string,
    decision: DecideWorkerPlanInput['decision'],
    correction?: string,
  ) => void;
  onSelect: (id: string) => void;
};

const ELAPSED_TICK_MS = 1000;

export function Delegations({
  session,
  children,
  enabled,
  pending,
  onDecision,
  onPlanDecision,
  onSelect,
}: Props) {
  const now = useNow(ELAPSED_TICK_MS);
  const current = session.delegations.filter(
    delegation => delegation.runId === session.runId,
  );
  const previousChildren = children.filter(
    child =>
      !current.some(delegation => delegation.childSessionId === child.id),
  );
  if (current.length === 0 && children.length === 0) return null;
  const entries = listSubsessions(session, children);
  const elapsedOf = (child: Session | undefined) => {
    const entry = child && entries.find(item => item.session.id === child.id);
    return entry ? elapsedLabel(entry.startedAt, entry.finishedAt, now) : '';
  };
  const childOf = (id: string | null | undefined) =>
    id ? children.find(child => child.id === id) : undefined;
  return (
    <section
      aria-label="Workers"
      data-workers=""
      className={cn(infoPanelSurface, 'p-1')}
    >
      <SectionLabel as="h2" count={current.length + previousChildren.length}>
        Workers
      </SectionLabel>
      <ul role="list" className="space-y-px">
        {current.map(delegation => {
          const child = childOf(delegation.childSessionId);
          const deciding =
            !!pending[
              `${entityKey(session)}/${delegation.runId}/${delegation.id}`
            ];
          const isCurrentRun =
            enabled &&
            session.status === 'running' &&
            session.runId === delegation.runId &&
            !deciding;
          return (
            <WorkerItem
              key={delegation.id}
              title={delegation.title}
              delegation={delegation}
              child={child}
              current
              elapsed={elapsedOf(child)}
              canDecide={isCurrentRun && delegation.status === 'pending'}
              canDecidePlan={isCurrentRun}
              deciding={deciding}
              onDecision={decision => onDecision(delegation.id, decision)}
              onPlanDecision={(decision, correction) =>
                onPlanDecision(delegation.id, decision, correction)
              }
              onOpen={() => child && onSelect(entityKey(child))}
            />
          );
        })}
        {previousChildren.map(child => (
          <WorkerItem
            key={child.id}
            title={child.title}
            delegation={session.delegations.find(
              delegation => delegation.childSessionId === child.id,
            )}
            child={child}
            current={false}
            elapsed={elapsedOf(child)}
            canDecide={false}
            canDecidePlan={false}
            deciding={false}
            onDecision={() => undefined}
            onPlanDecision={() => undefined}
            onOpen={() => onSelect(entityKey(child))}
          />
        ))}
      </ul>
    </section>
  );
}
