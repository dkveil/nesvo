import { useCallback, useEffect, useRef, useState } from 'react';

import { applyPage, MAX_LOADED_JOBS, nextLoadablePage, type PagedList } from '@entities/job';
import { useWorkspace } from '@entities/workspace';

import type { JobSummary } from '@shared/api/host';

type JobList = PagedList<JobSummary> & { receivedAt: number | null };
type PageRequest = { id: string; replace: boolean };

const EMPTY_LIST: JobList = { items: [], nextPage: null, lastPage: 0, receivedAt: null };

export const useJobList = (active: boolean) => {
  const { client, connected, hostCapabilities, mode } = useWorkspace();
  const supported = mode === 'live' && hostCapabilities?.jobPages === true;
  const [list, setList] = useState<JobList>(EMPTY_LIST);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const pageRequest = useRef<PageRequest | null>(null);
  const listRef = useRef(list);
  const hostId = hostCapabilities?.hostId ?? null;
  const lastHost = useRef(hostId ?? '');

  useEffect(() => {
    listRef.current = list;
  }, [list]);

  const request = useCallback(
    (page: number, replace: boolean) => {
      if (pageRequest.current && !replace) return;
      const requestId = client.requestId();
      pageRequest.current = { id: requestId, replace };
      setLoading(true);
      if (client.requestJobs(page, requestId)) return;
      pageRequest.current = null;
      setLoading(false);
    },
    [client],
  );

  const refresh = useCallback(() => request(0, true), [request]);
  const revisit = useCallback(() => request(0, listRef.current.receivedAt === null), [request]);
  const loadMore = useCallback(() => {
    const { nextPage, items } = listRef.current;
    const page = nextLoadablePage(nextPage, items.length, MAX_LOADED_JOBS);
    if (page !== null) request(page, false);
  }, [request]);

  useEffect(
    () =>
      client.subscribe(event => {
        const pending = pageRequest.current;
        if (event.type === 'jobPage' && pending && event.requestId === pending.id) {
          pageRequest.current = null;
          setLoading(false);
          setNotice('');
          setList(current => ({
            ...applyPage(
              current,
              { items: event.jobs, page: event.page, nextPage: event.nextPage },
              pending.replace,
              MAX_LOADED_JOBS,
            ),
            receivedAt: Date.now(),
          }));
        } else if (event.type === 'error' && pending && event.requestId === pending.id) {
          pageRequest.current = null;
          setLoading(false);
          setNotice(event.message);
        } else if (event.type === 'capabilities' && (event.hostId ?? '') !== lastHost.current) {
          lastHost.current = event.hostId ?? '';
          pageRequest.current = null;
          setLoading(false);
          setList(EMPTY_LIST);
        } else if (event.type === 'disconnected') {
          pageRequest.current = null;
          setLoading(false);
        }
      }),
    [client],
  );

  useEffect(() => {
    if (!active || !connected || !supported) return;
    const timer = setTimeout(revisit, 0);
    return () => clearTimeout(timer);
  }, [active, connected, supported, hostId, revisit]);

  return {
    supported,
    connected,
    jobs: supported ? list.items : EMPTY_LIST.items,
    nextPage: supported ? list.nextPage : null,
    receivedAt: supported ? list.receivedAt : null,
    loading,
    notice,
    dismissNotice: () => setNotice(''),
    refresh,
    loadMore,
  };
};
