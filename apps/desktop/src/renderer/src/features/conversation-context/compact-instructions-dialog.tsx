import { useId, useState } from 'react';
import { compactInstructionsMaxLength } from '@nesvo/contracts';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

type Props = {
  title: string;
  error: string;
  onCompact: (instructions: string) => Promise<boolean>;
  onClose: () => void;
};

export function CompactInstructionsDialog({
  title,
  error,
  onCompact,
  onClose,
}: Props) {
  const id = useId();
  const [instructions, setInstructions] = useState('');
  const trimmed = instructions.trim();
  return (
    <ConfirmDialog
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
      title="Compact with instructions"
      description={`Claude Code summarizes “${title}” to free context and keeps what you ask for. The history in Nesvo stays as it is.`}
      confirmLabel="Compact conversation"
      pendingLabel="Starting…"
      tone="default"
      onConfirm={() => (trimmed ? onCompact(trimmed) : false)}
    >
      <Field id={id} label="Instructions">
        <Textarea
          id={id}
          value={instructions}
          maxLength={compactInstructionsMaxLength}
          rows={3}
          placeholder="Keep the API decisions and open questions"
          onChange={event => setInstructions(event.target.value)}
        />
      </Field>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </ConfirmDialog>
  );
}
