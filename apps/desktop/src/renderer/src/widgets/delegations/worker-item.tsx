import { useId, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type {
  DecideDelegationInput,
  DecideWorkerPlanInput,
} from '@nesvo/contracts';
import { modelLabel, modeLabel, type Session } from '@/entities/session';
import { statusTextTones } from '@/entities/session/subsession-status';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';
import { KeyValueList } from '@/shared/ui/key-value-list';
import { ListRow } from '@/shared/ui/list-row';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import { WorkerPlan } from './worker-plan';
import { workerStatus } from './worker-status';

type Delegation = Session['delegations'][number];

type WorkerItemProps = {
  title: string;
  delegation: Delegation | undefined;
  child: Session | undefined;
  current: boolean;
  elapsed: string;
  canDecide: boolean;
  canDecidePlan: boolean;
  deciding: boolean;
  onDecision: (decision: DecideDelegationInput['decision']) => void;
  onPlanDecision: (
    decision: DecideWorkerPlanInput['decision'],
    correction?: string,
  ) => void;
  onOpen: () => void;
  worktreeAction?: ReactNode;
  restartAction?: ReactNode;
};

const detailsInset = 'pr-2 pb-2 pl-7';

export function WorkerItem({
  title,
  delegation,
  child,
  current,
  elapsed,
  canDecide,
  canDecidePlan,
  deciding,
  onDecision,
  onPlanDecision,
  onOpen,
  worktreeAction,
  restartAction,
}: WorkerItemProps) {
  const status = workerStatus(delegation, child);
  const pending = current && delegation?.status === 'pending';
  const [toggled, setToggled] = useState<boolean | null>(null);
  const expanded = toggled ?? (pending || status.tone === 'error');
  const detailsId = useId();
  const finished = !status.attention && status.variant !== 'spinner';
  const result = child?.worktree?.workerResolution;
  const resultLabel =
    result === 'merge'
      ? 'Merged'
      : result === 'discard'
        ? 'Discarded'
        : child?.worktree?.state === 'removed'
          ? 'Worktree removed'
          : status.state;
  return (
    <li
      role="group"
      aria-label={title}
      data-worker-row=""
      id={delegation ? `delegation-${delegation.id}` : undefined}
    >
      <ListRow
        leading={
          <StatusDot tone={status.tone} variant={status.variant} size="md" />
        }
        title={title}
        trailing={
          <>
            {(status.attention || finished) && (
              <span className={statusTextTones[status.tone]}>
                {resultLabel}
              </span>
            )}
            {elapsed && <span>{elapsed}</span>}
          </>
        }
        aria-expanded={delegation ? expanded : undefined}
        aria-controls={delegation ? detailsId : undefined}
        mainProps={{
          'aria-label': [title, resultLabel, elapsed, delegation && 'details']
            .filter(Boolean)
            .join(', '),
        }}
        onClick={delegation ? () => setToggled(!expanded) : onOpen}
        actionsPlacement="visible"
        actions={
          <>
            {restartAction}
            {worktreeAction}
            {child && (
              <IconButton size={24} label={`Open ${title}`} onClick={onOpen}>
                <ChevronRight />
              </IconButton>
            )}
          </>
        }
      />
      {pending && (
        <div className={cn(detailsInset, 'space-y-1.5')}>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="xs"
              disabled={!canDecide}
              onClick={() => onDecision('accept')}
            >
              Approve worker
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!canDecide}
              onClick={() => onDecision('decline')}
            >
              Decline
            </Button>
          </div>
          {(deciding || !canDecide) && (
            <StatusMessage tone={deciding ? 'loading' : 'info'}>
              {deciding
                ? 'Sending decision…'
                : 'This proposal is inactive. Check the connection and session status.'}
            </StatusMessage>
          )}
        </div>
      )}
      {current && delegation?.status === 'plan-ready' && (
        <div className={detailsInset}>
          <WorkerPlan
            key={delegation.planRound}
            plan={delegation.plan ?? ''}
            round={delegation.planRound}
            canDecide={canDecidePlan}
            deciding={deciding}
            onDecision={onPlanDecision}
          />
        </div>
      )}
      {delegation && (
        <div
          id={detailsId}
          hidden={!expanded}
          className={cn(detailsInset, 'space-y-2 text-xs')}
        >
          <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
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
                label: 'Directory',
                value: delegation.directory,
              },
              {
                key: 'runtime',
                label: 'Runs with',
                value: [
                  delegation.provider,
                  modelLabel(delegation.model),
                  modeLabel(delegation.provider, delegation.mode),
                  ...(delegation.planFirst ? ['Plan first'] : []),
                ].join(' · '),
              },
            ]}
          />
          {delegation.error && (
            <StatusMessage tone="error" className="whitespace-pre-wrap">
              {delegation.error}
            </StatusMessage>
          )}
        </div>
      )}
    </li>
  );
}
