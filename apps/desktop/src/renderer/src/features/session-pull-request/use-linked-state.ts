import { useEffect, useState } from 'react';
import type { PullRequestReference } from '@nesvo/contracts';
import {
  visualState,
  type PullRequestApi,
  type PullRequestVisualState,
} from '@/entities/pull-request';

const STATE_CACHE_MS = 60_000;

const cache = new Map<string, { state: PullRequestVisualState; at: number }>();

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
  const [loaded, setLoaded] = useState<{
    key: string;
    state: PullRequestVisualState;
  } | null>(null);
  useEffect(() => {
    if (!reference || !enabled) return;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < STATE_CACHE_MS) return;
    let current = true;
    void api.readPullRequest(reference).then(
      pullRequest => {
        const state = visualState(pullRequest);
        cache.set(key, { state, at: Date.now() });
        if (current) setLoaded({ key, state });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [api, enabled, key, reference]);
  if (!key) return null;
  if (loaded?.key === key) return loaded.state;
  return cache.get(key)?.state ?? null;
}
