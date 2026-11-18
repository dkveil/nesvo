import { type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ListRow } from '@/shared/ui/list-row';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';

import { interruptedByRestart } from './worker-status';

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

export function WorkerRestartMenu({
  workers,
  error,
  ...actions
}: Actions & { workers: Session[]; error: string }) {
  if (!workers.length) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Interrupted workers, ${workers.length}`}
        >
          {workers.length} interrupted
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <SectionLabel
          as="h2"
          action={<ContinueAllWorkers workers={workers} {...actions} />}
        >
          Workers
        </SectionLabel>
        <ul className="max-h-60 divide-y divide-border/40 overflow-auto">
          {workers.map(worker => (
            <li key={worker.id}>
              <ListRow
                title={worker.title}
                density="two-line"
                description={interruptedByRestart}
                actions={<WorkerContinue worker={worker} {...actions} />}
              />
            </li>
          ))}
        </ul>
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </PopoverContent>
    </Popover>
  );
}
