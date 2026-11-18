import { useEffect, useState } from 'react';
import type { DesktopApi, MergedWorktreeCleanup } from '@nesvo/contracts';
import { errorDetail, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Skeleton } from '@/shared/ui/skeleton';
import { StatusMessage } from '@/shared/ui/status-message';
import { CleanupReport } from './cleanup-report';

type Props = {
  session: Session;
  api: Pick<DesktopApi, 'readMergedWorktreeCleanup' | 'finishMergedWorktree'>;
  onClose: () => void;
};

export function FinishAfterMergeDialog({ session, api, onClose }: Props) {
  const [cleanup, setCleanup] = useState<MergedWorktreeCleanup | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let current = true;
    void api.readMergedWorktreeCleanup({ sessionId: session.id }).then(
      report => {
        if (current) setCleanup(report);
      },
      failure => {
        if (current) setError(errorDetail(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [api, session.id]);
  const finish = async () => {
    setPending(true);
    setError('');
    try {
      const result = await api.finishMergedWorktree({
        sessionId: session.id,
        revision: session.revision,
      });
      setCleanup(result.cleanup);
      if (result.outcome === 'finished') onClose();
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  const ready = !!cleanup && cleanup.blockers.length === 0;
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="gap-4 sm:max-w-md" data-finish-after-merge="">
        <DialogHeader>
          <DialogTitle>Finish after merge</DialogTitle>
          <DialogDescription>
            {`Removes the worktree of “${session.title}” and runs its recipe clean-up, deletes the local branch only because GitHub reports the pull request as merged, and archives the session. History stays and can be restored.`}
          </DialogDescription>
        </DialogHeader>
        {cleanup ? (
          <CleanupReport cleanup={cleanup} />
        ) : (
          !error && <Skeleton shape="block" className="h-24 w-full" />
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        <DialogFooter>
          <DialogCancel onClick={onClose} disabled={pending} />
          <Button
            size="lg"
            disabled={!ready || pending}
            aria-busy={pending || undefined}
            onClick={() => void finish()}
          >
            {pending ? 'Finishing…' : 'Finish after merge'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
