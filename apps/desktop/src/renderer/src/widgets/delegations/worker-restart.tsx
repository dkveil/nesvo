import { type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';

type Actions = {
  enabled: boolean;
  pending: boolean;
  onContinue: (workers: Session[]) => void;
};

const canContinueWorker = (worker: Session) =>
  !!worker.providerSessionId &&
  worker.providerInitialized &&
  !worker.archivedAt &&
  (!worker.worktree || worker.worktree.state === 'active');

export function WorkerContinue({
  worker,
  enabled,
  pending,
  onContinue,
}: Actions & { worker: Session }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={!enabled || pending || !canContinueWorker(worker)}
      aria-label={`Continue ${worker.title}`}
      onClick={() => onContinue([worker])}
    >
      Continue
    </Button>
  );
}

export function ContinueAllWorkers({
  workers,
  enabled,
  pending,
  onContinue,
}: Actions & { workers: Session[] }) {
  const resumable = workers.filter(canContinueWorker);
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={!enabled || pending || !resumable.length}
      onClick={() => onContinue(resumable)}
    >
      Continue all
    </Button>
  );
}
