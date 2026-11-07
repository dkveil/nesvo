import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopApi, Review, Session } from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';

export function desktopApi(): DesktopApi {
  if (!window.nesvo)
    throw new Error(
      'The app connection is unavailable. Reload the window or reopen Nesvo.',
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
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(true);
  const [reviewsError, setReviewsError] = useState('');
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
  const mergeReviews = useCallback((updates: Review[]) => {
    setReviews(previous => {
      const merged = new Map(previous.map(review => [review.id, review]));
      for (const review of updates) {
        const current = merged.get(review.id);
        if (!current || review.revision > current.revision)
          merged.set(review.id, review);
      }
      return [...merged.values()].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.version - left.version ||
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
            error: `Could not check ${provider}. ${errorDetail(failure)}`,
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
        else if (event.type === 'review-changed') mergeReviews([event.review]);
        else if (event.type === 'host-disconnected') {
          disconnected = true;
          setConnection('unavailable');
          setError(
            'The host disconnected. Refresh the connection or reopen Nesvo to restore your history.',
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
                ? `Could not connect to the host. ${errorDetail(health.reason)}`
                : history.status === 'rejected'
                  ? `Could not load the conversation history. ${errorDetail(history.reason)}`
                  : '',
            );
          }
          if (history.status === 'fulfilled') merge(history.value);
          setLoading(false);
        },
      );
      void api.listReviews().then(
        history => {
          if (!active) return;
          mergeReviews(history);
          setReviewsError('');
          setReviewsLoading(false);
        },
        failure => {
          if (!active) return;
          setReviewsError(
            `Could not load the results. ${errorDetail(failure)}`,
          );
          setReviewsLoading(false);
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
        setReviewsLoading(false);
        setReviewsError(errorDetail(failure));
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
  }, [attempt, inspectProvider, merge, mergeReviews]);
  const refresh = () => {
    setLoading(true);
    setReviewsLoading(true);
    setConnection('connecting');
    setAttempt(value => value + 1);
  };
  const recover = async () => {
    const history = await desktopApi().listSessions();
    merge(history);
    return history;
  };
  const recoverReviews = async () => {
    const history = await desktopApi().listReviews();
    mergeReviews(history);
    setReviewsError('');
    return history;
  };
  return {
    sessions,
    reviews,
    reviewsLoading,
    reviewsError,
    mergeReviews,
    recoverReviews,
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
