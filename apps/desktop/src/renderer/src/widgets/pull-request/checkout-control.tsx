import { useState } from 'react';
import type { PullRequest } from '@nesvo/contracts';
import { GitBranch } from 'lucide-react';
import type { Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { ActionFeedback } from './action-feedback';
import { DisabledHint } from './disabled-hint';
import { isActionLocked, type ActionState } from './use-pull-request-actions';

type CheckoutControlProps = {
  pullRequest: PullRequest;
  session: Session;
  blockedReason: string;
  state: ActionState | undefined;
  onCheckout: () => Promise<boolean>;
};

export function CheckoutControl({
  pullRequest,
  session,
  blockedReason,
  state,
  onCheckout,
}: CheckoutControlProps) {
  const [confirming, setConfirming] = useState(false);
  const pending = state?.status === 'pending';
  const locked = isActionLocked(state);
  const busy = session.status === 'running' || session.status === 'stopping';
  const reason =
    blockedReason ||
    (busy ? 'Wait until the session finishes its current turn.' : '') ||
    (pullRequest.state === 'merged' ? 'This pull request is merged.' : '');
  const confirm = async () => {
    if (await onCheckout()) setConfirming(false);
  };
  return (
    <>
      <DisabledHint reason={reason}>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!!reason || locked}
          onClick={() => setConfirming(true)}
          className="h-7 text-xs text-muted-foreground enabled:hover:text-foreground disabled:cursor-not-allowed"
        >
          <GitBranch />
          {pending ? 'Checking out…' : 'Check out'}
        </Button>
      </DisabledHint>
      <Dialog
        open={confirming}
        onOpenChange={open => {
          if (!locked) setConfirming(open);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">
              Check out #{pullRequest.number}?
            </DialogTitle>
            <DialogDescription className="text-xs leading-5">
              Switches the session folder{' '}
              <span className="font-mono [overflow-wrap:anywhere]">
                {session.directory}
              </span>{' '}
              to the branch{' '}
              <span className="font-mono">{pullRequest.headRefName}</span>.
              Uncommitted changes there can block the checkout. Session
              permissions stay the same.
            </DialogDescription>
          </DialogHeader>
          {(state?.status === 'error' || state?.status === 'unknown') && (
            <ActionFeedback state={state} />
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={locked}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={locked}
              onClick={() => void confirm()}
            >
              {pending ? 'Checking out…' : 'Check out'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
