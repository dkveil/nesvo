import { useEffect, useRef, useState } from 'react';
import type {
  DesktopApi,
  DesktopSession,
  FinishSessionWorktreeInput,
  SessionWorktree,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Checkbox } from '@/shared/ui/checkbox';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Label } from '@/shared/ui/label';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { StatusMessage } from '@/shared/ui/status-message';
import { WorktreeSetup } from './worktree-setup';

type Choice = FinishSessionWorktreeInput['action']['kind'];

type Props = {
  sessionId: string;
  worktree: SessionWorktree;
  api: Pick<
    DesktopApi,
    | 'readSessionWorktree'
    | 'finishSessionWorktree'
    | 'readSessionWorktreeSetup'
    | 'runSessionWorktreeSetup'
  >;
  setupAvailable: boolean;
  blockedReason: string;
  onFinished: (session: DesktopSession, choice: Choice) => void;
  onClose: () => void;
};

const choices = [
  { value: 'keep', label: 'Keep' },
  { value: 'pull-request', label: 'Pull request' },
  { value: 'remove', label: 'Remove' },
] satisfies { value: Choice; label: string }[];

const choiceDetails: Record<Choice, string> = {
  keep: 'Finish the session and keep the local worktree.',
  'pull-request':
    'Finish the session and open Pull requests with this branch selected. Publishing the branch and creating the pull request stay separate steps.',
  remove: 'Permanently remove the worktree folder and keep the Git branch.',
};

export function FinishWorktreeDialog({
  api,
  sessionId,
  worktree,
  setupAvailable,
  blockedReason,
  onFinished,
  onClose,
}: Props) {
  const [choice, setChoice] = useState<Choice>(
    worktree.state === 'active' ? 'keep' : 'pull-request',
  );
  const [dirty, setDirty] = useState<boolean | null>(null);
  const [force, setForce] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const submitting = useRef(false);
  const removed = worktree.state === 'removed';
  useEffect(() => {
    if (removed || blockedReason) return;
    let current = true;
    void api.readSessionWorktree({ sessionId }).then(
      status => {
        if (current) {
          setDirty(status.dirty);
          setStatusError('');
        }
      },
      failure => {
        if (current) {
          setDirty(null);
          setStatusError(errorDetail(failure));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [api, blockedReason, refresh, removed, sessionId]);
  const disabled =
    pending ||
    !!blockedReason ||
    (choice === 'remove' && (removed || dirty === null || (dirty && !force)));
  const finish = async () => {
    if (disabled || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const session = await api.finishSessionWorktree({
        sessionId,
        action:
          choice === 'remove'
            ? { kind: choice, force: dirty === true && force }
            : { kind: choice },
      });
      onFinished(session, choice);
      onClose();
    } catch (failure) {
      setError(errorDetail(failure));
      setDirty(null);
      setForce(false);
      setRefresh(value => value + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={next => !next && !submitting.current && onClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Finish worktree</DialogTitle>
          <DialogDescription className="break-all">
            {worktree.branch}
          </DialogDescription>
        </DialogHeader>
        <SegmentedControl
          label="Finish action"
          size="md"
          fullWidth
          value={choice}
          onChange={next => {
            setChoice(next);
            setForce(false);
          }}
          disabled={pending}
          options={choices.map(option => ({
            ...option,
            disabled:
              (option.value === 'keep' && worktree.state !== 'active') ||
              (option.value === 'remove' && removed),
          }))}
        />
        <StatusMessage tone="info">{choiceDetails[choice]}</StatusMessage>
        {worktree.includes && (
          <StatusMessage
            tone={worktree.includes.incomplete ? 'warning' : 'info'}
          >
            Worktree includes: {worktree.includes.copied} copied,{' '}
            {worktree.includes.skipped} skipped.
            {worktree.includes.incomplete &&
              ' The include scan was incomplete.'}
          </StatusMessage>
        )}
        {blockedReason ? (
          <StatusMessage tone="warning">{blockedReason}</StatusMessage>
        ) : statusError ? (
          <StatusMessage tone="error">{statusError}</StatusMessage>
        ) : !removed && dirty === null ? (
          <StatusMessage tone="loading">
            Checking worktree changes…
          </StatusMessage>
        ) : dirty ? (
          <StatusMessage tone="warning" variant="notice">
            This worktree contains uncommitted changes or local files.
          </StatusMessage>
        ) : null}
        {choice === 'remove' && dirty && (
          <Label className="flex items-center gap-2">
            <Checkbox
              checked={force}
              onCheckedChange={value => setForce(value === true)}
              disabled={pending}
            />
            Discard uncommitted changes and local files
          </Label>
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        {setupAvailable && worktree.state !== 'removed' && (
          <WorktreeSetup
            api={api}
            sessionId={sessionId}
            disabled={!!blockedReason || pending || worktree.state !== 'active'}
            onRun={() => setRefresh(value => value + 1)}
          />
        )}
        <DialogFooter>
          <DialogCancel onClick={onClose} disabled={pending} />
          <Button
            size="lg"
            variant={choice === 'remove' ? 'destructive' : 'default'}
            disabled={disabled}
            aria-busy={pending || undefined}
            onClick={() => void finish()}
          >
            {pending
              ? 'Finishing…'
              : choice === 'remove'
                ? 'Remove worktree'
                : choice === 'keep'
                  ? 'Finish and keep'
                  : 'Finish and open pull requests'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
