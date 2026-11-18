import { useCallback, useEffect, useState } from 'react';
import type { ClaudeAutonomy, ClaudeAutonomyInput } from '@nesvo/contracts';

export function useClaudeAutonomy(hostId: string, ready: boolean) {
  const [snapshot, setSnapshot] = useState<{
    hostId: string;
    data: ClaudeAutonomy;
  }>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!ready) return;
    let current = true;
    void window.nesvo.claudeAutonomy({ action: 'read' }, hostId).then(
      data => {
        if (!current) return;
        setSnapshot({ hostId, data });
        setError('');
      },
      failure => {
        if (current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Permissions are unavailable.',
          );
      },
    );
    return () => {
      current = false;
    };
  }, [hostId, ready]);

  const execute = useCallback(
    async (input: ClaudeAutonomyInput) => {
      const data = await window.nesvo.claudeAutonomy(input, hostId);
      if (input.action !== 'confirm-full-access') setSnapshot({ hostId, data });
      return data;
    },
    [hostId],
  );

  return {
    data: ready && snapshot?.hostId === hostId ? snapshot.data : null,
    error,
    execute,
  };
}
