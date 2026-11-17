import { useEffect, useState } from 'react';
import type {
  ListPullRequestsInput,
  PullRequestList,
  PullRequestListScope,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { PullRequestApi } from '@/entities/pull-request';

const SEARCH_DEBOUNCE_MS = 300;

type UsePullRequestListParams = {
  api: PullRequestApi | null;
  hostId: string;
  directory: string;
  repository: string;
  scope: PullRequestListScope;
  query: string;
  refresh: number;
};

type Settled =
  | { key: string; list: PullRequestList; error: '' }
  | { key: string; list: null; error: string };

type LoadedList = { source: string; list: PullRequestList };

type UsePullRequestListResult = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  list: PullRequestList | null;
  hostId: string;
  error: string;
};

export function usePullRequestList({
  api,
  hostId,
  directory,
  repository,
  scope,
  query,
  refresh,
}: UsePullRequestListParams): UsePullRequestListResult {
  const [settled, setSettled] = useState<Settled | null>(null);
  const [lastList, setLastList] = useState<LoadedList | null>(null);
  const enabled = !!api && (!!directory || !!repository);
  const source = JSON.stringify([hostId, repository || directory, scope]);
  const key = JSON.stringify([source, query, refresh]);
  useEffect(() => {
    if (!api || (!directory && !repository)) return;
    let current = true;
    const input: ListPullRequestsInput = {
      scope,
      ...(repository ? { repository } : { directory }),
      ...(query ? { query } : {}),
    };
    const timer = window.setTimeout(
      () => {
        void api.listPullRequests(input).then(
          list => {
            if (!current) return;
            setSettled({ key, list, error: '' });
            setLastList({ source, list });
          },
          failure => {
            if (current)
              setSettled({ key, list: null, error: errorDetail(failure) });
          },
        );
      },
      query ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [api, directory, repository, scope, query, source, key]);
  if (!enabled) return { status: 'idle', list: null, hostId, error: '' };
  if (settled?.key !== key)
    return {
      status: 'loading',
      list: lastList?.source === source ? lastList.list : null,
      hostId,
      error: '',
    };
  return settled.list
    ? { status: 'ready', list: settled.list, hostId, error: '' }
    : { status: 'error', list: null, hostId, error: settled.error };
}
