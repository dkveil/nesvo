import { useState, type FormEvent, type ReactNode } from 'react';
import type { DecideWorkerPlanInput } from '@nesvo/contracts';
import {
  directoryLabel,
  modeLabel,
  modelLabel,
  workerPlanRoundLimit,
  type Session,
} from '@/entities/session';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { cn } from 'cn';
import { MessageBody } from '@/widgets/conversation/message-body';

type Props = {
  session: Session;
  delegation: Session['delegations'][number];
  sessionLink: ReactNode;
  hostLabel: string;
  enabled: boolean;
  deciding: boolean;
  error: string;
  className?: string;
  onDecision: (
    decision: DecideWorkerPlanInput['decision'],
    correction?: string,
  ) => void;
};

export const WorkerPlanRow = ({
  session,
  delegation,
  sessionLink,
  hostLabel,
  enabled,
  deciding,
  error,
  className,
  onDecision,
}: Props) => {
  const [expanded, setExpanded] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState('');
  const trimmed = correction.trim();
  const locked = delegation.planRound > workerPlanRoundLimit;
  const plan = delegation.plan || 'The worker returned an empty plan.';
  const submitCorrection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || locked || !trimmed) return;
    onDecision('correct', trimmed);
  };
  return (
    <article
      aria-label={`Worker plan: ${delegation.title}`}
      data-host-id={session.hostId}
      className={className}
    >
      <div className="min-w-0 space-y-1">
        {sessionLink}
        {hostLabel && (
          <p className="text-2xs text-muted-foreground">{hostLabel}</p>
        )}
        <p className="flex flex-wrap items-center gap-2 text-[13px] leading-5">
          <span className="[overflow-wrap:anywhere]">{delegation.title}</span>
          {delegation.planFirst && <Badge variant="outline">Plan first</Badge>}
        </p>
        <p className="text-2xs leading-4 text-muted-foreground">
          {delegation.planRound > 1
            ? `Revised plan ${delegation.planRound}`
            : 'Proposed plan'}{' '}
          · {delegation.provider} · {modelLabel(delegation.model)} ·{' '}
          {modeLabel(delegation.provider, delegation.mode)} ·{' '}
          {directoryLabel(delegation.directory)}
        </p>
        <MessageBody
          body={plan}
          className={cn(
            'rounded-lg border bg-background/60 p-3 text-[13px]',
            !expanded && 'max-h-36 overflow-hidden',
          )}
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-2xs font-normal text-muted-foreground"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse plan' : 'Expand plan'}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? 'Show less' : 'Show full plan'}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 self-center">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 px-2.5 text-[13px] font-normal"
          aria-label="Accept plan"
          disabled={!enabled}
          onClick={() => onDecision('accept')}
        >
          Accept plan
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[13px] font-normal"
          aria-label="Send correction"
          aria-expanded={correcting}
          disabled={!enabled}
          onClick={() => setCorrecting(value => !value)}
        >
          Send correction
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[13px] font-normal text-muted-foreground"
          aria-label="Decline worker"
          disabled={!enabled}
          onClick={() => onDecision('decline')}
        >
          Decline worker
        </Button>
      </div>
      {correcting && (
        <form className="col-span-full space-y-2" onSubmit={submitCorrection}>
          <Textarea
            aria-label="Correction"
            placeholder="Describe what the plan should change"
            maxLength={4000}
            value={correction}
            disabled={!enabled || locked}
            onChange={event => setCorrection(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              variant="outline"
              aria-label="Submit correction"
              disabled={!enabled || locked || !trimmed}
            >
              Submit correction
            </Button>
            {locked && (
              <p role="note" className="text-xs text-muted-foreground">
                This worker revised its plan five times. Accept or decline it.
              </p>
            )}
          </div>
        </form>
      )}
      {deciding && (
        <p
          role="status"
          className="col-span-full text-2xs text-muted-foreground"
        >
          Sending decision…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="col-span-full text-xs text-destructive [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
    </article>
  );
};
