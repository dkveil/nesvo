import {
  listSubsessions,
  isWorkerInterruptedByRestart,
  type DecideDelegationInput,
  type DecideWorkerPlanInput,
} from '@nesvo/contracts';
import { elapsedLabel } from '@/entities/activity';
import type { Session } from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';
import { useNow } from '@/shared/lib/use-now';
import { SectionLabel } from '@/shared/ui/section-label';
import { WorkerItem } from './worker-item';
import { activeChild } from './worker-status';
import { WorkerWorktree } from './worker-worktree';
import { ContinueAllWorkers, WorkerContinue } from './worker-restart';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  session: Session;
  children: Session[];
  enabled: boolean;
  worktreeActions?: boolean;
  pending: Record<string, boolean>;
  restartEnabled: boolean;
  restartPending: boolean;
  restartError: string;
  onContinueWorkers: (workers: Session[]) => void;
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
  worktreeActions,
  pending,
  restartEnabled,
  restartPending,
  restartError,
  onContinueWorkers,
  onDecision,
  onPlanDecision,
  onSelect,
}: Props) {
  const now = useNow(ELAPSED_TICK_MS);
  const agentTurnVisible = session.messages.some(
    message => message.runId === session.runId && message.author === 'agent',
  );
  const waiting =
    session.status === 'running' &&
    session.coordinatorWait?.runId === session.runId &&
    !session.coordinatorWait.away &&
    agentTurnVisible;
  const inlineIds = new Set(
    waiting
      ? children
          .filter(
            child => child.parentRunId === session.runId && activeChild(child),
          )
          .map(child => child.id)
      : [],
  );
  const current = session.delegations.filter(
    delegation => delegation.runId === session.runId,
  );
  const displayed = current.filter(
    delegation =>
      delegation.status !== 'running' ||
      !delegation.childSessionId ||
      !inlineIds.has(delegation.childSessionId),
  );
  const previousChildren = children.filter(
    child =>
      !inlineIds.has(child.id) &&
      !current.some(delegation => delegation.childSessionId === child.id),
  );
  if (displayed.length === 0 && previousChildren.length === 0 && !restartError)
    return null;
  const entries = listSubsessions(session, children);
  const elapsedOf = (child: Session | undefined) => {
    const entry = child && entries.find(item => item.session.id === child.id);
    return entry ? elapsedLabel(entry.startedAt, entry.finishedAt, now) : '';
  };
  const childOf = (id: string | null | undefined) =>
    id ? children.find(child => child.id === id) : undefined;
  const restarted = children.filter(isWorkerInterruptedByRestart);
  const restartActions = {
    enabled: restartEnabled,
    pending: restartPending,
    onContinue: onContinueWorkers,
  };
  const restartAction = (child: Session | undefined) =>
    child && isWorkerInterruptedByRestart(child) ? (
      <WorkerContinue worker={child} {...restartActions} />
    ) : undefined;
  const worktreeAction = (child: Session | undefined) =>
    worktreeActions &&
    child?.worktree?.workerTargetBranch &&
    child.worktree.state === 'active' &&
    child.runId &&
    child.status !== 'running' &&
    child.status !== 'stopping' ? (
      <WorkerWorktree parent={session} worker={child} enabled={enabled} />
    ) : undefined;
  return (
    <section aria-label="Workers" data-workers="">
      <SectionLabel
        as="h2"
        count={displayed.length + previousChildren.length}
        action={
          restarted.length > 0 && (
            <ContinueAllWorkers workers={restarted} {...restartActions} />
          )
        }
      >
        Workers
      </SectionLabel>
      {restartError && (
        <StatusMessage tone="error">{restartError}</StatusMessage>
      )}
      <ul role="list" className="divide-y divide-border/40">
        {displayed.map(delegation => {
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
              worktreeAction={worktreeAction(child)}
              restartAction={restartAction(child)}
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
            worktreeAction={worktreeAction(child)}
            restartAction={restartAction(child)}
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
