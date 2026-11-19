import { useId, useState } from 'react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Textarea } from '@/shared/ui/textarea';
import { StatusMessage } from '@/shared/ui/status-message';

export function PolicyOverride({
  hostId,
  runId,
  stepId,
}: {
  hostId: string;
  runId: string;
  stepId: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const save = async () => {
    setBusy(true);
    setFailure('');
    try {
      await window.nesvo.gateRules(
        {
          action: 'autonomy-override',
          input: { runId, stepId, overrideId: crypto.randomUUID(), reason },
        },
        hostId,
      );
      setOpen(false);
    } catch (error) {
      setFailure(errorDetail(error));
    } finally {
      setBusy(false);
    }
  };
  return open ? (
    <form
      className="space-y-2"
      onSubmit={event => {
        event.preventDefault();
        if (!busy && reason.trim()) void save();
      }}
    >
      <Field
        label="Override reason"
        id={id}
        hint="Reject this result and lower the gate's autonomy by one level."
      >
        <Textarea
          id={id}
          value={reason}
          maxLength={1000}
          onChange={event => setReason(event.target.value)}
        />
      </Field>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="xs"
          variant="secondary"
          disabled={busy || !reason.trim()}
        >
          Reject and lower autonomy
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      {failure && <StatusMessage tone="error">{failure}</StatusMessage>}
    </form>
  ) : (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => setOpen(true)}
    >
      Override policy approval
    </Button>
  );
}
