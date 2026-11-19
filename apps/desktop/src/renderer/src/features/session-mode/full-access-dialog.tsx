import { useState } from 'react';
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
}: {
  directory: string;
  provider: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
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
          <DialogTitle>Allow Full access in this session?</DialogTitle>
          <DialogDescription className="text-ui leading-relaxed text-foreground">
            From the next turn, {provider} can run commands and change files
            without approval, including outside this folder. It can access the
            network and sensitive data available to your account.
          </DialogDescription>
        </DialogHeader>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0">Session folder ·</span>
          <MiddleTruncatedText path value={directory} className="font-mono" />
        </p>
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        <DialogFooter>
          <DialogCancel disabled={pending} onClick={onClose} autoFocus />
          <Button
            variant="outline"
            className="text-warning-foreground"
            disabled={pending}
            onClick={() => void confirm()}
          >
            Allow Full access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
