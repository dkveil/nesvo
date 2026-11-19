import { useRef, useState } from 'react';
import { errorDetail, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';

export type SteeringRequest = NonNullable<Session['steeringRequests']>[number];

export function SteeringDecisionActions({
  child,
  request,
  enabled,
}: {
  child: Session;
  request: SteeringRequest;
  enabled: boolean;
}) {
  const attempts = useRef(new Map<'accept' | 'decline', string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const decide = async (decision: 'accept' | 'decline') => {
    const actionId = attempts.current.get(decision) ?? crypto.randomUUID();
    attempts.current.set(decision, actionId);
    setPending(true);
    setError('');
    try {
      await window.nesvo.decideChildSteering(
        {
          sessionId: child.id,
          expectedRunId: request.runId,
          requestId: request.id,
          actionId,
          decision,
        },
        child.hostId,
      );
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        size="xs"
        disabled={!enabled || pending}
        onClick={() => void decide('accept')}
      >
        Send feedback
      </Button>
      <Button
        size="xs"
        variant="ghost"
        disabled={!enabled || pending}
        onClick={() => void decide('decline')}
      >
        Decline
      </Button>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </div>
  );
}
