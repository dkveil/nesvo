import { useEffect, useState } from 'react';
import type {
  DesktopApi,
  PullRequestListScope,
  TrackedPullRequestList,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

const SEARCH_DEBOUNCE_MS = 300;

type UseTrackedPullRequestListsParams = {
  api: Pick<DesktopApi, 'listTrackedPullRequests'> | null;
  hostId: string;
  enabled: boolean;
  scope: PullRequestListScope;
  query: string;
  refresh: number;
};

type Settled =
  | { key: string; lists: TrackedPullRequestList[]; error: '' }
  | { key: string; lists: null; error: string };

type UseTrackedPullRequestListsResult = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  lists: TrackedPullRequestList[];
  error: string;
};

export function useTrackedPullRequestLists({
  api,
  hostId,
  enabled,
  scope,
  query,
  refresh,
}: UseTrackedPullRequestListsParams): UseTrackedPullRequestListsResult {
  const [settled, setSettled] = useState<Settled | null>(null);
  const [last, setLast] = useState<{
    source: string;
    lists: TrackedPullRequestList[];
  } | null>(null);
  const source = JSON.stringify([hostId, scope]);
  const key = JSON.stringify([source, query, refresh]);
  useEffect(() => {
    if (!api || !enabled) return;
    let current = true;
    const timer = window.setTimeout(
      () => {
        void api
          .listTrackedPullRequests({ scope, ...(query ? { query } : {}) })
          .then(
            lists => {
              if (!current) return;
              setSettled({ key, lists, error: '' });
              setLast({ source, lists });
            },
            failure => {
              if (current)
                setSettled({ key, lists: null, error: errorDetail(failure) });
            },
          );
      },
      query ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [api, enabled, scope, query, source, key]);
  if (!api || !enabled) return { status: 'idle', lists: [], error: '' };
  if (settled?.key !== key)
    return {
      status: 'loading',
      lists: last?.source === source ? last.lists : [],
      error: '',
    };
  return settled.lists
    ? { status: 'ready', lists: settled.lists, error: '' }
    : { status: 'error', lists: [], error: settled.error };
}
