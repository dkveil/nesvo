import { useState } from 'react';
import { Checkbox } from '@/shared/ui/checkbox';
import { Label } from '@/shared/ui/label';
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
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { StatusMessage } from '@/shared/ui/status-message';

export function FullAccessDialog({
  directory,
  provider,
  onConfirm,
  onClose,
  reReview,
}: {
  directory: string;
  provider: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  reReview?: { description: string; onConfirm: () => void };
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [reviewedAgain, setReviewedAgain] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    if (!acknowledged || pending || (reReview && !reviewedAgain)) return;
    setPending(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Full access could not be confirmed.',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle size="sm">
            Allow Full access in this session?
          </DialogTitle>
          <DialogDescription className="text-ui leading-relaxed text-foreground">
            From the next turn, {provider} can run commands and change files
            without approval, including outside this folder. It can use the
            network and access sensitive data available to your account.
          </DialogDescription>
        </DialogHeader>
        <p className="flex min-w-0 items-center gap-1.5 rounded-control bg-code-background px-3 py-2 text-xs text-muted-foreground">
          <span className="shrink-0">Session folder ·</span>
          <MiddleTruncatedText path value={directory} className="font-mono" />
        </p>
        <Label className="flex items-center gap-2 text-ui">
          <Checkbox
            checked={acknowledged}
            disabled={pending}
            onCheckedChange={value => setAcknowledged(value === true)}
          />
          I understand
        </Label>
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        {reReview && (
          <Label className="flex items-center gap-2 text-ui">
            <Checkbox
              checked={reviewedAgain}
              disabled={pending}
              onCheckedChange={value => {
                setReviewedAgain(value === true);
                if (value === true) reReview.onConfirm();
              }}
            />
            {reReview.description}
          </Label>
        )}
        <DialogFooter>
          <DialogCancel disabled={pending} onClick={onClose} autoFocus />
          <Button
            variant="destructive"
            size="lg"
            disabled={
              pending || !acknowledged || Boolean(reReview && !reviewedAgain)
            }
            onClick={() => void confirm()}
          >
            Allow Full access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
