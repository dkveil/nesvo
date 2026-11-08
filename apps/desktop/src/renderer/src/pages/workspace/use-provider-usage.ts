import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi, ProviderUsage } from '@nesvo/contracts';
import { providers, type Provider } from '@/entities/session';

export type UsageState = {
  data?: ProviderUsage;
  loading: boolean;
  error: boolean;
};

const empty: Record<Provider, UsageState> = {
  'Claude Code': { loading: false, error: false },
  Codex: { loading: false, error: false },
};

export function useProviderUsage(
  hostId: string,
  connected: boolean,
  api: Pick<DesktopApi, 'providerUsage'> | undefined,
  terminal: string,
) {
  const [byHost, setByHost] = useState<
    Record<string, Partial<Record<Provider, UsageState>>>
  >({});
  const generation = useRef({ value: 0 });
  const previousTerminal = useRef({ hostId, terminal });
  const pending = useRef(new Map<string, number>());
  const lastRequest = useRef<Record<string, number>>({});
  const refresh = useCallback(async () => {
    if (!connected || !api) return;
    const current = generation.current.value;
    lastRequest.current[hostId] = Date.now();
    await Promise.allSettled(
      providers.map(async provider => {
        const key = `${hostId}/${provider}`;
        if (pending.current.get(key) === current) return;
        pending.current.set(key, current);
        setByHost(previous => ({
          ...previous,
          [hostId]: {
            ...previous[hostId],
            [provider]: {
              ...previous[hostId]?.[provider],
              loading: true,
              error: false,
            },
          },
        }));
        try {
          const data = await api.providerUsage({ provider });
          if (generation.current.value !== current) return;
          if (data.provider !== provider)
            throw new Error('Mismatched provider.');
          setByHost(previous => ({
            ...previous,
            [hostId]: {
              ...previous[hostId],
              [provider]: { data, loading: false, error: false },
            },
          }));
        } catch {
          if (generation.current.value === current)
            setByHost(previous => ({
              ...previous,
              [hostId]: {
                ...previous[hostId],
                [provider]: {
                  ...previous[hostId]?.[provider],
                  loading: false,
                  error: true,
                },
              },
            }));
        } finally {
          if (pending.current.get(key) === current) pending.current.delete(key);
        }
      }),
    );
  }, [api, connected, hostId]);
  useEffect(() => {
    const clock = generation.current;
    const current = ++clock.value;
    const requests = pending.current;
    queueMicrotask(() => {
      if (clock.value === current && document.visibilityState === 'visible')
        void refresh();
    });
    const poll = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const resume = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - (lastRequest.current[hostId] ?? 0) >= 120000
      )
        void refresh();
    };
    const timer = window.setInterval(poll, 120000);
    document.addEventListener('visibilitychange', resume);
    return () => {
      ++clock.value;
      for (const [key, value] of requests)
        if (value === current) requests.delete(key);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [hostId, refresh]);
  useEffect(() => {
    const previous = previousTerminal.current;
    previousTerminal.current = { hostId, terminal };
    if (previous.hostId !== hostId || previous.terminal === terminal) return;
    if (!terminal || !connected) return;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [terminal, hostId, connected, refresh]);
  return { states: { ...empty, ...byHost[hostId] }, refresh };
}
