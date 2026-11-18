import { useEffect, useRef, useState } from 'react';
import { Ellipsis, GitFork } from 'lucide-react';
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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { IconButton } from '@/shared/ui/icon-button';
import { Label } from '@/shared/ui/label';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { StatusMessage } from '@/shared/ui/status-message';

type Choice = FinishSessionWorktreeInput['action']['kind'];

type Props = {
  sessionId: string;
  worktree: SessionWorktree;
  api: Pick<DesktopApi, 'readSessionWorktree' | 'finishSessionWorktree'>;
  blockedReason: string;
  onFinished: (session: DesktopSession, choice: Choice) => void;
};

const choices = [
  { value: 'keep', label: 'Keep' },
  { value: 'pull-request', label: 'Open pull request' },
  { value: 'remove', label: 'Remove' },
] satisfies { value: Choice; label: string }[];

const choiceDetails: Record<Choice, string> = {
  keep: 'Finish the session and keep the local worktree.',
  'pull-request':
    'Finish the session and open Pull requests with the branch selected. Publish the branch and create the pull request separately.',
  remove: 'Permanently remove the worktree folder and keep the Git branch.',
};

export function FinishWorktree(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <IconButton size={32} label="Session actions">
            <Ellipsis />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setOpen(true)}>
            <GitFork />
            Finish…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open && <FinishDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function FinishDialog({
  api,
  sessionId,
  worktree,
  blockedReason,
  onFinished,
  onClose,
}: Props & { onClose: () => void }) {
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
          <DialogTitle>Finish worktree session</DialogTitle>
          <DialogDescription className="break-all">
            {worktree.branch}
          </DialogDescription>
        </DialogHeader>
        <SegmentedControl
          label="Finish action"
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={choice === 'remove' ? 'destructive' : 'default'}
            disabled={disabled}
            onClick={() => void finish()}
          >
            {pending
              ? 'Finishing…'
              : choice === 'remove'
                ? 'Remove worktree'
                : choice === 'keep'
                  ? 'Finish and keep'
                  : 'Open pull requests'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
