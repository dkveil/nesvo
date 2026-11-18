import { useCallback, useEffect, useRef, useState } from 'react';
import type { McpServerList } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

type ListState = {
  key: string;
  list?: McpServerList;
  loading?: boolean;
  error?: string;
};

export function useMcpConfiguration(
  hostId: string,
  sessionId: string | undefined,
  refreshKey: string | null,
  enabled: boolean,
) {
  const key = hostId + ':' + sessionId;
  const [state, setState] = useState<ListState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const refresh = useCallback(async () => {
    if (!enabled || !sessionId) return;
    const current = ++generation.current;
    setState(previous => ({
      ...(previous?.key === key ? previous : { key }),
      loading: true,
      error: undefined,
    }));
    try {
      const list = await window.nesvo.listMcpServers({ sessionId }, hostId);
      if (current === generation.current) setState({ key, list });
    } catch (error) {
      if (current === generation.current)
        setState({
          key,
          error: 'Could not read MCP configuration. ' + errorDetail(error),
        });
    }
  }, [enabled, hostId, key, sessionId]);
  useEffect(() => {
    if (refreshKey === null) return;
    void refresh();
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    return () => {
      invalidate();
      window.removeEventListener('focus', focus);
    };
  }, [invalidate, refresh, refreshKey]);

  const visible = state?.key === key && enabled ? state : null;
  const repository = visible?.list?.repository;
  const decisionKey = repository ? key + ':' + repository.fingerprint : null;
  const trust = async () => {
    if (!repository || !enabled || !sessionId || !decisionKey) return;
    const current = ++generation.current;
    setPending(decisionKey);
    try {
      const list = await window.nesvo.trustRepositoryMcp(
        { sessionId, fingerprint: repository.fingerprint },
        hostId,
      );
      if (current === generation.current) setState({ key, list });
    } catch (error) {
      if (current !== generation.current) return;
      await refresh();
      setState(previous =>
        previous?.key === key
          ? { ...previous, error: errorDetail(error) }
          : previous,
      );
    } finally {
      setPending(previous => (previous === decisionKey ? null : previous));
    }
  };
  return {
    ...visible,
    refresh,
    trust,
    pending: !!decisionKey && pending === decisionKey,
    showDecision:
      repository?.status === 'needs-trust' && dismissed !== decisionKey,
    dismiss: () => setDismissed(decisionKey),
    reopen: () => {
      setDismissed(null);
      void refresh();
    },
  };
}

export type McpConfiguration = ReturnType<typeof useMcpConfiguration>;
