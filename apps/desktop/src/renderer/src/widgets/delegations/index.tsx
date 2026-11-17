import type {
  DecideDelegationInput,
  DecideWorkerPlanInput,
} from '@nesvo/contracts';
import { ArrowUpRight, GitBranch } from 'lucide-react';
import {
  delegationStatusLabels,
  modelLabel,
  modeLabel,
  sessionStatusLabel,
  type Session,
} from '@/entities/session';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { ListRow } from '@/shared/ui/list-row';
import { StatusMessage } from '@/shared/ui/status-message';
import { entityKey } from '@/shared/lib/host-key';
import { WorkerPlan } from './worker-plan';

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

const childStatusLabel = (session: Session, child: Session) => {
  const proposal = session.delegations.find(
    delegation => delegation.childSessionId === child.id,
  );
  return proposal &&
    proposal.status !== 'running' &&
    proposal.status !== 'completed'
    ? delegationStatusLabels[proposal.status]
    : sessionStatusLabel(child);
};

export function Delegations({
  session,
  children,
  enabled,
  pending,
  onDecision,
  onPlanDecision,
  onSelect,
}: Props) {
  const current = session.delegations.filter(
    delegation => delegation.runId === session.runId,
  );
  const previousChildren = children.filter(
    child =>
      !current.some(delegation => delegation.childSessionId === child.id),
  );
  if (
    !session.delegationEnabled &&
    current.length === 0 &&
    children.length === 0
  )
    return null;
  return (
    <section aria-label="Delegation" className="space-y-4 border-t pt-5">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <GitBranch className="size-4" />
        Workers
      </h2>
      {current.map(delegation => {
        const child = children.find(
          item => item.id === delegation.childSessionId,
        );
        const deciding =
          !!pending[
            `${entityKey(session)}/${delegation.runId}/${delegation.id}`
          ];
        const isCurrentRun =
          enabled &&
          session.status === 'running' &&
          session.runId === delegation.runId &&
          !deciding;
        const canDecide = isCurrentRun && delegation.status === 'pending';
        const showsChildStatus =
          delegation.status === 'running' || delegation.status === 'completed';
        return (
          <section
            key={delegation.id}
            id={`delegation-${delegation.id}`}
            aria-label="Worker proposal"
            className="space-y-3 rounded-surface border bg-card p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
                  {delegation.title}
                </h3>
                {delegation.planFirst && (
                  <Badge appearance="outline">Plan first</Badge>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {child && showsChildStatus
                  ? sessionStatusLabel(child)
                  : delegationStatusLabels[delegation.status]}
              </span>
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
              {delegation.task}
            </p>
            <KeyValueList
              entries={[
                {
                  key: 'scope',
                  label: 'Scope',
                  value: (
                    <span className="whitespace-pre-wrap">
                      {delegation.scope}
                    </span>
                  ),
                },
                {
                  key: 'directory',
                  label: 'Relative directory',
                  value: delegation.directory,
                },
                {
                  key: 'runtime',
                  label: 'Runs with',
                  value: [
                    delegation.provider,
                    modelLabel(delegation.model),
                    modeLabel(delegation.provider, delegation.mode),
                  ].join(' · '),
                },
              ]}
            />
            {delegation.status === 'pending' && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={!canDecide}
                    onClick={() => onDecision(delegation.id, 'accept')}
                  >
                    Approve worker
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canDecide}
                    onClick={() => onDecision(delegation.id, 'decline')}
                  >
                    Decline
                  </Button>
                </div>
                <StatusMessage tone={deciding ? 'loading' : 'info'}>
                  {deciding
                    ? 'Sending decision…'
                    : canDecide
                      ? 'Starts this worker with the scope and access shown above.'
                      : 'This proposal is inactive. Check the connection and session status.'}
                </StatusMessage>
              </>
            )}
            {delegation.status === 'plan-ready' && (
              <WorkerPlan
                key={delegation.planRound}
                plan={delegation.plan ?? ''}
                round={delegation.planRound}
                canDecide={isCurrentRun}
                deciding={deciding}
                onDecision={(decision, correction) =>
                  onPlanDecision(delegation.id, decision, correction)
                }
              />
            )}
            {child && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onSelect(entityKey(child))}
              >
                Open worker session
                <ArrowUpRight />
              </Button>
            )}
            {delegation.error && (
              <StatusMessage tone="error" className="whitespace-pre-wrap">
                {delegation.error}
              </StatusMessage>
            )}
          </section>
        );
      })}
      {previousChildren.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Previous workers</p>
          {previousChildren.map(child => (
            <ListRow
              key={child.id}
              title={child.title}
              trailing={
                <>
                  {childStatusLabel(session, child)}
                  <ArrowUpRight className="size-3" />
                </>
              }
              onClick={() => onSelect(entityKey(child))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
