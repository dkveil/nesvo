import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi, Session } from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';

export function desktopApi(): DesktopApi {
  if (!window.nesvo)
    throw new Error(
      'Brak połączenia z aplikacją. Odśwież okno lub ponownie otwórz Nesvo.',
    );
  return window.nesvo;
}

function initialProviders(): ProviderStates {
  return {
    'Claude Code': { status: null, loading: true, error: '' },
    Codex: { status: null, loading: true, error: '' },
  };
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connection, setConnection] = useState<
    'connecting' | 'ready' | 'unavailable'
  >('connecting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [providerStates, setProviderStates] = useState(initialProviders);
  const [attempt, setAttempt] = useState(0);
  const statusRequests = useRef<Record<Provider, number>>({
    'Claude Code': 0,
    Codex: 0,
  });
  const merge = useCallback((updates: Session[]) => {
    setSessions(previous => {
      const merged = new Map(previous.map(session => [session.id, session]));
      for (const session of updates) {
        const current = merged.get(session.id);
        if (!current || session.revision > current.revision)
          merged.set(session.id, session);
      }
      return [...merged.values()].sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      );
    });
  }, []);
  const inspectProvider = useCallback(async (provider: Provider) => {
    const request = ++statusRequests.current[provider];
    setProviderStates(previous => ({
      ...previous,
      [provider]: { ...previous[provider], loading: true, error: '' },
    }));
    try {
      const api = desktopApi();
      const status = await (provider === 'Claude Code'
        ? api.claudeStatus()
        : api.codexStatus());
      if (request === statusRequests.current[provider])
        setProviderStates(previous => ({
          ...previous,
          [provider]: { status, loading: false, error: '' },
        }));
    } catch (failure) {
      if (request === statusRequests.current[provider])
        setProviderStates(previous => ({
          ...previous,
          [provider]: {
            ...previous[provider],
            loading: false,
            error: `Nie udało się sprawdzić ${provider}. ${errorDetail(failure)}`,
          },
        }));
    }
  }, []);
  useEffect(() => {
    const requestCounters = statusRequests.current;
    let active = true;
    let disconnected = false;
    let unsubscribe = () => {};
    try {
      const api = desktopApi();
      unsubscribe = api.subscribe(event => {
        if (!active) return;
        if (event.type === 'session-changed') merge([event.session]);
        else {
          disconnected = true;
          setConnection('unavailable');
          setError(
            'Połączenie z hostem zostało przerwane. Odśwież połączenie lub ponownie otwórz Nesvo, aby odzyskać historię.',
          );
        }
      });
      void Promise.allSettled([api.health(), api.listSessions()]).then(
        ([health, history]) => {
          if (!active) return;
          if (!disconnected) {
            setConnection(
              health.status === 'fulfilled' ? 'ready' : 'unavailable',
            );
            setError(
              health.status === 'rejected'
                ? `Nie udało się połączyć z hostem. ${errorDetail(health.reason)}`
                : history.status === 'rejected'
                  ? `Nie udało się odczytać historii. ${errorDetail(history.reason)}`
                  : '',
            );
          }
          if (history.status === 'fulfilled') merge(history.value);
          setLoading(false);
        },
      );
      queueMicrotask(() => {
        if (active)
          for (const provider of providers) void inspectProvider(provider);
      });
    } catch (failure) {
      queueMicrotask(() => {
        if (!active) return;
        setConnection('unavailable');
        setLoading(false);
        setProviderStates(
          previous =>
            Object.fromEntries(
              providers.map(provider => [
                provider,
                { ...previous[provider], loading: false },
              ]),
            ) as ProviderStates,
        );
        setError(errorDetail(failure));
      });
    }
    return () => {
      active = false;
      for (const provider of providers) requestCounters[provider] += 1;
      unsubscribe();
    };
  }, [attempt, inspectProvider, merge]);
  const refresh = () => {
    setLoading(true);
    setConnection('connecting');
    setAttempt(value => value + 1);
  };
  const recover = async () => {
    const history = await desktopApi().listSessions();
    merge(history);
    return history;
  };
  return {
    sessions,
    connection,
    loading,
    error,
    providerStates,
    merge,
    refresh,
    refreshProvider: inspectProvider,
    recover,
  };
}
