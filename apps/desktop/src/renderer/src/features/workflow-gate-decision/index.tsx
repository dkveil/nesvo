import { useState, type FormEvent } from 'react';
import {
  decideWorkflowGateSchema,
  type HumanDecisionAnswer,
} from '@nesvo/contracts';
import { TypedGateInput } from './typed-gate-input';
import { errorDetail } from '@/entities/session';
import type { WorkflowRun, WorkflowStepRecord } from '@/entities/workflow';
import { Button } from '@/shared/ui/button';
import { Composer, ComposerInput, ComposerToolbar } from '@/shared/ui/composer';
import { StatusMessage } from '@/shared/ui/status-message';

type Decision = 'accept' | 'fix' | 'reject';

export function WorkflowGateDecision({
  run,
  step,
  enabled,
}: {
  run: WorkflowRun;
  step: WorkflowStepRecord;
  enabled: boolean;
}) {
  const [editing, setEditing] = useState<'fix' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const form = step.decisionForm;
  const typed = form && form.form.kind !== 'binary';
  const decide = async (decision: Decision, answer?: HumanDecisionAnswer) => {
    if (!enabled || busy) return;
    const input = decideWorkflowGateSchema.safeParse({
      runId: run.id,
      stepId: step.id,
      reviewId: step.reviewId,
      version: step.reviewVersion,
      decisionId: crypto.randomUUID(),
      decision,
      ...(answer ? { answer } : {}),
      comment: decision === 'accept' ? '' : comment,
    });
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? 'Check the decision.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await window.nesvo.workflows.decideGate(run.hostId, input.data);
    } catch (reason) {
      setError(errorDetail(reason));
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (editing) void decide(editing);
  };
  return (
    <>
      {step.recommendation && (
        <p className="col-span-full text-ui text-muted-foreground">
          <span className="font-medium text-foreground">
            {step.recommendation.outcome === 'would-approve'
              ? 'Would approve'
              : 'Needs approval'}
          </span>{' '}
          {step.recommendation.reason}
        </p>
      )}
      <div data-inbox-actions className="flex-wrap">
        {!typed && (
          <Button
            variant="secondary"
            disabled={!enabled || busy}
            onClick={() => void decide('accept')}
          >
            {form ? 'Approve' : 'Accept'}
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={!enabled || busy}
          aria-expanded={editing === 'fix'}
          onClick={() => setEditing('fix')}
        >
          Fix
        </Button>
        <Button
          variant="ghost"
          disabled={!enabled || busy}
          aria-expanded={editing === 'reject'}
          onClick={() => setEditing('reject')}
        >
          Reject
        </Button>
      </div>
      {typed && !editing && (
        <TypedGateInput
          decision={form}
          enabled={enabled && !busy}
          onSubmit={answer => void decide('accept', answer)}
        />
      )}
      {editing && (
        <form className="col-span-full max-w-2xl" onSubmit={submit}>
          <Composer variant="compact">
            <ComposerInput
              autoFocus
              aria-label={editing === 'fix' ? 'Fix comment' : 'Reject comment'}
              placeholder={
                editing === 'fix'
                  ? 'What should change?'
                  : 'Why are you rejecting this step?'
              }
              value={comment}
              onChange={event => setComment(event.target.value)}
            />
            <ComposerToolbar
              start={
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditing(null);
                    setComment('');
                    setError('');
                  }}
                >
                  Cancel
                </Button>
              }
              end={
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={!enabled || busy || !comment.trim()}
                >
                  {editing === 'fix' ? 'Request fix' : 'Reject step'}
                </Button>
              }
            />
          </Composer>
        </form>
      )}
      {(error || busy || !enabled) && (
        <StatusMessage
          className="col-span-full"
          tone={error ? 'error' : busy ? 'loading' : 'info'}
        >
          {error ||
            (busy ? 'Saving decision…' : 'Reconnect to decide this step.')}
        </StatusMessage>
      )}
    </>
  );
}
