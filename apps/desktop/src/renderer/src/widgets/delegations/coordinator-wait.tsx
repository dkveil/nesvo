import { useState } from 'react';
import { errorDetail, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = {
  session: Session;
  sessions: Session[];
  enabled: boolean;
  onContinue: () => Promise<void>;
};

export function CoordinatorWait({
  session,
  sessions,
  enabled,
  onContinue,
}: Props) {
  const wait = session.coordinatorWait;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!wait) return null;
  const workers = sessions.filter(
    child =>
      child.hostId === session.hostId &&
      child.parentId === session.id &&
      (child.parentRunId === wait.runId ||
        wait.workers.some(item => item.sessionId === child.id)),
  );
  const waiting =
    workers.filter(
      child =>
        child.status === 'running' ||
        child.status === 'stopping' ||
        child.queue.some(message => !message.held) ||
        child.plan?.status === 'plan-ready',
    ).length +
    session.delegations.filter(
      item =>
        item.runId === wait.runId &&
        (item.status === 'pending' || item.status === 'plan-ready'),
    ).length;
  const finished = workers.filter(child =>
    child.messages.some(
      message =>
        message.author === 'agent' &&
        message.state === 'completed' &&
        message.completedAt &&
        message.completedAt >= wait.startedAt &&
        (wait.workers.find(item => item.sessionId === child.id)?.runId ??
          child.runId) === message.runId,
    ),
  ).length;
  const resume = async () => {
    setPending(true);
    setError('');
    try {
      await onContinue();
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground"
      data-coordinator-wait
    >
      <span>
        Waiting on {waiting} {waiting === 1 ? 'worker' : 'workers'}
        {wait.away && ` / ${finished} finished while you were away`}
      </span>
      {wait.away && (
        <Button
          size="xs"
          disabled={
            !enabled ||
            pending ||
            session.status === 'running' ||
            session.status === 'stopping'
          }
          onClick={() => void resume()}
        >
          Continue
        </Button>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </div>
  );
}
