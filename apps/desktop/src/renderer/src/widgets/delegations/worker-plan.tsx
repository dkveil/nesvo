import { useState, type FormEvent } from 'react';
import type { DecideWorkerPlanInput } from '@nesvo/contracts';
import { Button } from '@/shared/ui/button';
import { Textarea } from '@/shared/ui/textarea';
import { MessageBody } from '@/widgets/conversation/message-body';

type Props = {
  plan: string;
  round: number;
  canDecide: boolean;
  deciding: boolean;
  onDecision: (
    decision: DecideWorkerPlanInput['decision'],
    correction?: string,
  ) => void;
};

export function WorkerPlan({
  plan,
  round,
  canDecide,
  deciding,
  onDecision,
}: Props) {
  const [correction, setCorrection] = useState('');
  const trimmed = correction.trim();
  const submitCorrection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canDecide || !trimmed) return;
    onDecision('correct', trimmed);
  };
  return (
    <section aria-label="Worker plan" className="space-y-3">
      <h4 className="text-xs text-muted-foreground">
        {round > 1 ? `Revised plan ${round}` : 'Proposed plan'}
      </h4>
      <MessageBody
        body={plan || 'The worker returned an empty plan.'}
        className="rounded-lg border bg-background/60 p-3 text-sm"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="md"
          disabled={!canDecide}
          onClick={() => onDecision('accept')}
        >
          Accept plan
        </Button>
        <Button
          type="button"
          size="md"
          variant="ghost"
          disabled={!canDecide}
          onClick={() => onDecision('decline')}
        >
          Decline worker
        </Button>
      </div>
      <form className="space-y-2" onSubmit={submitCorrection}>
        <Textarea
          size="lg"
          aria-label="Correction"
          placeholder="Describe what the plan should change"
          maxLength={4000}
          value={correction}
          disabled={!canDecide}
          onChange={event => setCorrection(event.target.value)}
        />
        <Button
          type="submit"
          size="md"
          variant="outline"
          disabled={!canDecide || !trimmed}
        >
          Send correction
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        {deciding
          ? 'Sending decision…'
          : canDecide
            ? 'Accepting lets the worker continue with the access shown above. A correction asks for a revised plan without changes. Declining ends the worker without changes.'
            : 'This plan is inactive. Check the connection and session status.'}
      </p>
    </section>
  );
}
