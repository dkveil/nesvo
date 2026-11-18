import {
  useCallback,
  useEffect,
  useEffectEvent,
  useSyncExternalStore,
} from 'react';
import type { PullRequest, PullRequestReference } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { PullRequestApi } from './index';

const DETAILS_CACHE_MS = 60_000;
const DETAILS_CACHE_LIMIT = 200;

type CachedDetails = { data: PullRequest | null; error: string; at: number };

export type PullRequestDetails = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  data: PullRequest | null;
  error: string;
};

const cache = new Map<string, CachedDetails>();
const pending = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

const detailsKey = (hostId: string, reference: PullRequestReference) =>
  `${hostId}/${reference.repository.toLowerCase()}#${reference.number}`;

const store = (key: string, entry: CachedDetails) => {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size > DETAILS_CACHE_LIMIT)
    cache.delete(cache.keys().next().value as string);
  for (const listener of listeners.get(key) ?? []) listener();
};

const subscribe = (key: string, listener: () => void) => {
  const current = listeners.get(key) ?? new Set();
  current.add(listener);
  listeners.set(key, current);
  return () => {
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
};

export function recentPullRequestRepositories(hostId: string): string[] {
  const prefix = `${hostId}/`;
  const repositories = new Map<string, string>();
  for (const [key, entry] of [...cache].reverse()) {
    if (!key.startsWith(prefix) || !entry.data) continue;
    const repository = entry.data.repository;
    if (!repositories.has(repository.toLowerCase()))
      repositories.set(repository.toLowerCase(), repository);
  }
  return [...repositories.values()];
}

export function cachedPullRequest(
  hostId: string,
  reference: PullRequestReference,
): PullRequest | null {
  return cache.get(detailsKey(hostId, reference))?.data ?? null;
}

export function primePullRequestDetails(
  hostId: string,
  pullRequest: PullRequest,
) {
  store(detailsKey(hostId, pullRequest), {
    data: pullRequest,
    error: '',
    at: Date.now(),
  });
}

type UsePullRequestDetailsParams = {
  hostId: string;
  reference: PullRequestReference | null;
  api: Pick<PullRequestApi, 'readPullRequest'> | null;
  enabled: boolean;
};

export function usePullRequestDetails({
  hostId,
  reference,
  api,
  enabled,
}: UsePullRequestDetailsParams): PullRequestDetails {
  const key = reference ? detailsKey(hostId, reference) : '';
  const entry = useSyncExternalStore(
    useCallback(listener => subscribe(key, listener), [key]),
    () => cache.get(key),
  );
  const read = useEffectEvent(() =>
    reference && api
      ? api.readPullRequest(reference)
      : Promise.reject(new Error('Pull requests are unavailable.')),
  );
  const active = enabled && !!api;
  useEffect(() => {
    if (!key || !active || pending.has(key)) return;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < DETAILS_CACHE_MS) return;
    pending.add(key);
    void read()
      .then(
        data => store(key, { data, error: '', at: Date.now() }),
        failure =>
          store(key, {
            data: cache.get(key)?.data ?? null,
            error: errorDetail(failure),
            at: Date.now(),
          }),
      )
      .finally(() => pending.delete(key));
  }, [key, active]);
  if (!key) return { status: 'idle', data: null, error: '' };
  if (entry?.data) return { status: 'ready', data: entry.data, error: '' };
  if (entry?.error) return { status: 'error', data: null, error: entry.error };
  return { status: active ? 'loading' : 'idle', data: null, error: '' };
}
