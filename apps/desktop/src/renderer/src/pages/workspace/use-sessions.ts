import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClaudeStatus, DesktopApi, Session } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

export function desktopApi(): DesktopApi {
  if (!window.nesvo)
    throw new Error(
      'Brak połączenia z aplikacją. Odśwież okno lub ponownie otwórz Nesvo.',
    );
  return window.nesvo;
}

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connection, setConnection] = useState<
    'connecting' | 'ready' | 'unavailable'
  >('connecting');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [claudeLoading, setClaudeLoading] = useState(true);
  const [claudeError, setClaudeError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const statusRequest = useRef(0);
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
  useEffect(() => {
    let active = true;
    let disconnected = false;
    let unsubscribe = () => {};
    const request = ++statusRequest.current;
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
      void api.claudeStatus().then(
        status => {
          if (active && request === statusRequest.current) {
            setClaude(status);
            setClaudeError('');
            setClaudeLoading(false);
          }
        },
        failure => {
          if (active && request === statusRequest.current) {
            setClaudeError(
              `Nie udało się sprawdzić Claude Code. ${errorDetail(failure)}`,
            );
            setClaudeLoading(false);
          }
        },
      );
    } catch (failure) {
      queueMicrotask(() => {
        if (!active) return;
        setConnection('unavailable');
        setLoading(false);
        setClaudeLoading(false);
        setError(errorDetail(failure));
      });
    }
    return () => {
      active = false;
      statusRequest.current += 1;
      unsubscribe();
    };
  }, [attempt, merge]);
  const refresh = () => {
    setLoading(true);
    setConnection('connecting');
    setClaudeLoading(true);
    setAttempt(value => value + 1);
  };
  const refreshClaude = async () => {
    const request = ++statusRequest.current;
    setClaudeLoading(true);
    setClaudeError('');
    try {
      const status = await desktopApi().claudeStatus();
      if (request === statusRequest.current) setClaude(status);
    } catch (failure) {
      if (request === statusRequest.current)
        setClaudeError(
          `Nie udało się sprawdzić Claude Code. ${errorDetail(failure)}`,
        );
    } finally {
      if (request === statusRequest.current) setClaudeLoading(false);
    }
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
    claude,
    claudeLoading,
    claudeError,
    merge,
    refresh,
    refreshClaude,
    recover,
  };
}
