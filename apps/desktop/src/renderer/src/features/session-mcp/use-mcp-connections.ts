import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HostId,
  McpConnectionAction,
  McpConnectionList,
  McpConnectionTarget,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

type State = {
  key: string;
  list?: McpConnectionList;
  pending?: { kind: McpConnectionAction; serverKey: string };
  loading?: boolean;
  error?: string;
};

export function useMcpConnections(
  hostId: HostId,
  target: McpConnectionTarget | undefined,
  enabled: boolean,
) {
  const sessionId =
    target && 'sessionId' in target ? target.sessionId : undefined;
  const provider = target && 'provider' in target ? target.provider : undefined;
  const profileId =
    target && 'profileId' in target ? target.profileId : undefined;
  const key = [hostId, sessionId, provider, profileId].join(':');
  const [state, setState] = useState<State | null>(null);
  const generation = useRef(0);
  const active = useRef<string | null>(null);
  const reading = useRef<string | null>(null);
  const running = useRef<string | null>(null);
  const invalidate = useCallback(() => {
    active.current = null;
    reading.current = null;
    generation.current++;
  }, []);
  const request = useCallback(
    async (action?: NonNullable<State['pending']>) => {
      if (
        !enabled ||
        (!sessionId && !provider) ||
        (action
          ? running.current !== null
          : running.current === key || reading.current === key)
      )
        return;
      if (action) {
        running.current = key;
        reading.current = null;
      } else reading.current = key;
      const current = ++generation.current;
      const isCurrent = () =>
        action ? active.current === key : current === generation.current;
      setState(previous => ({
        key,
        list: previous?.key === key ? previous.list : undefined,
        pending: action,
        loading: !action,
      }));
      try {
        const list = await window.nesvo.mcpConnections(
          {
            target: sessionId
              ? { sessionId }
              : { provider: provider!, profileId },
            action,
          },
          hostId,
        );
        if (isCurrent()) setState({ key, list });
      } catch (error) {
        if (isCurrent())
          setState(previous => ({
            key,
            list: previous?.key === key ? previous.list : undefined,
            error: errorDetail(error),
          }));
      } finally {
        if (action) running.current = null;
        else if (current === generation.current) reading.current = null;
      }
    },
    [enabled, hostId, key, profileId, provider, sessionId],
  );
  useEffect(() => {
    active.current = enabled ? key : null;
    void request();
    return invalidate;
  }, [enabled, invalidate, key, request]);
  return {
    ...(enabled && state?.key === key ? state : null),
    enabled,
    refresh: () => request(),
    act: (kind: McpConnectionAction, serverKey: string) =>
      request({ kind, serverKey }),
  };
}

export type McpConnections = ReturnType<typeof useMcpConnections>;
