import { useState } from 'react';
import type { ForkSessionInput } from '@nesvo/contracts';
import { Checkbox } from '@/shared/ui/checkbox';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Label } from '@/shared/ui/label';

type Props = {
  title: string;
  onFork: (worktree: ForkSessionInput['worktree']) => Promise<void>;
  onClose: () => void;
};

export function ForkWorktreeDialog({ title, onFork, onClose }: Props) {
  const [isolated, setIsolated] = useState(false);
  const [carryChanges, setCarryChanges] = useState(false);
  return (
    <ConfirmDialog
      open
      onOpenChange={next => {
        if (!next) onClose();
      }}
      title="Fork session"
      description={`Create a separate session from “${title}”.`}
      tone="default"
      confirmLabel="Fork session"
      pendingLabel="Forking…"
      onConfirm={() => onFork(isolated ? { carryChanges } : undefined)}
    >
      <Label className="flex items-center gap-2">
        <Checkbox
          checked={isolated}
          onCheckedChange={value => setIsolated(value === true)}
        />
        Fork into a new worktree
      </Label>
      {isolated && (
        <Label className="flex items-center gap-2">
          <Checkbox
            checked={carryChanges}
            onCheckedChange={value => setCarryChanges(value === true)}
          />
          Carry uncommitted changes
        </Label>
      )}
    </ConfirmDialog>
  );
}
