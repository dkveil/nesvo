import { useState } from 'react';
import type { WorkerWorktreeResult } from '@nesvo/contracts';
import { errorDetail, type Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { StatusMessage } from '@/shared/ui/status-message';

type Props = { parent: Session; worker: Session; enabled: boolean };

export function WorkerWorktree({ parent, worker, enabled }: Props) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<WorkerWorktreeResult | null>(null);
  const [action, setAction] = useState<'merge' | 'discard' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const target = { sessionId: parent.id, workerId: worker.id };
  const openResult = async () => {
    setResult(null);
    setAction(null);
    setError('');
    setOpen(true);
    setPending(true);
    try {
      setResult(
        await window.nesvo.workerWorktree(
          { ...target, action: 'read' },
          parent.hostId,
        ),
      );
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  const decide = async () => {
    if (!result || !action) return;
    setPending(true);
    setError('');
    try {
      await window.nesvo.workerWorktree(
        {
          ...target,
          action,
          confirmed: true,
          expectedHead: result.head,
          expectedTargetHead: result.targetHead,
        },
        parent.hostId,
      );
      setOpen(false);
    } catch (failure) {
      setError(errorDetail(failure));
      setAction(null);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        disabled={!enabled}
        onClick={() => void openResult()}
      >
        Review branch
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{worker.title}</DialogTitle>
            <DialogDescription>
              {result
                ? `${result.branch} to ${result.targetBranch}`
                : 'Worker branch and diff'}
            </DialogDescription>
          </DialogHeader>
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
          {pending && (
            <StatusMessage tone="loading">Working with Git?</StatusMessage>
          )}
          {result && (
            <>
              <ScrollArea className="h-72 min-w-0 rounded-md border">
                <pre className="p-3 font-mono text-xs">
                  {result.diff || 'No committed changes.'}
                </pre>
              </ScrollArea>
              {result.truncated && (
                <StatusMessage tone="info">
                  This diff is truncated.
                </StatusMessage>
              )}
              {result.dirty && (
                <StatusMessage tone="info">
                  Commit or remove the worker's uncommitted changes first.
                </StatusMessage>
              )}
              {action && (
                <StatusMessage tone="info">
                  {action === 'merge'
                    ? `Merge commit ${result.head.slice(0, 12)} into ${result.targetBranch} and remove the worker worktree?`
                    : 'Discard this result and remove its worktree? The branch will remain in Git.'}
                </StatusMessage>
              )}
              <DialogFooter>
                {action ? (
                  <>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => setAction(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant={action === 'discard' ? 'destructive' : 'default'}
                      disabled={pending || !enabled}
                      onClick={() => void decide()}
                    >
                      {action === 'merge' ? 'Confirm merge' : 'Confirm discard'}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      disabled={pending || result.dirty || !enabled}
                      onClick={() => setAction('discard')}
                    >
                      Discard
                    </Button>
                    <Button
                      disabled={pending || !result.canMerge || !enabled}
                      onClick={() => setAction('merge')}
                    >
                      Merge into coordinator
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
