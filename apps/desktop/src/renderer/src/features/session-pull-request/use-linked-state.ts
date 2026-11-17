import { useEffect, useEffectEvent, useState } from 'react';
import type { PullRequestReference } from '@nesvo/contracts';
import {
  visualState,
  type PullRequestApi,
  type PullRequestVisualState,
} from '@/entities/pull-request';

const STATE_CACHE_MS = 60_000;

type CachedState = { state: PullRequestVisualState | null; at: number };

const cache = new Map<string, CachedState>();
const pending = new Set<string>();

type UseLinkedStateParams = {
  hostId: string;
  reference: PullRequestReference | null;
  api: PullRequestApi;
  enabled: boolean;
};

export function useLinkedState({
  hostId,
  reference,
  api,
  enabled,
}: UseLinkedStateParams): PullRequestVisualState | null {
  const key = reference
    ? `${hostId}/${reference.repository}#${reference.number}`
    : '';
  const [loaded, setLoaded] = useState<CachedState & { key: string }>();
  const read = useEffectEvent(() =>
    reference ? api.readPullRequest(reference) : Promise.reject(),
  );
  useEffect(() => {
    if (!key || !enabled || pending.has(key)) return;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < STATE_CACHE_MS) return;
    let current = true;
    pending.add(key);
    const settle = (state: PullRequestVisualState | null) => {
      const entry = { state, at: Date.now() };
      cache.set(key, entry);
      pending.delete(key);
      if (current) setLoaded({ key, ...entry });
    };
    void read().then(
      pullRequest => settle(visualState(pullRequest)),
      () => settle(null),
    );
    return () => {
      current = false;
    };
  }, [enabled, key]);
  if (!key) return null;
  if (loaded?.key === key) return loaded.state;
  return cache.get(key)?.state ?? null;
}
