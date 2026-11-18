import { useEffect, useRef, useState, type ReactNode } from 'react';
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

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  tone?: 'destructive' | 'default';
  onConfirm: () => unknown;
  children?: ReactNode;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel,
  confirmDisabled = false,
  cancelLabel = 'Cancel',
  tone = 'destructive',
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const confirm = async () => {
    setPending(true);
    let keepOpen = false;
    try {
      keepOpen = (await onConfirm()) === false;
    } finally {
      if (mounted.current) {
        setPending(false);
        if (!keepOpen) onOpenChange(false);
      }
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!pending) onOpenChange(next);
      }}
    >
      <DialogContent
        data-slot="confirm-dialog"
        role="alertdialog"
        className="sm:max-w-sm"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <DialogCancel disabled={pending} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </DialogCancel>
          <Button
            size="lg"
            type="button"
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            disabled={pending || confirmDisabled}
            aria-busy={pending || undefined}
            onClick={() => void confirm()}
          >
            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
