import { useState } from 'react';
import type { AssistantUndoInput } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';

import { undoGateRule } from './undo-gate-rule';

export function GateRuleUndo({
  input,
  hostId,
}: {
  input: AssistantUndoInput;
  hostId: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const undo = async () => {
    setPending(true);
    setError('');
    try {
      await undoGateRule(hostId, input);
    } catch (reason) {
      setError(errorDetail(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        disabled={pending}
        onClick={() => void undo()}
      >
        Undo
      </Button>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </>
  );
}
