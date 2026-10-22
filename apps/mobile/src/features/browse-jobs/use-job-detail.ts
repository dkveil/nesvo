import { useCallback, useEffect, useRef, useState } from 'react';

import { MAX_LOADED_OCCURRENCES, mergePage, nextLoadablePage } from '@entities/job';
import { useWorkspace } from '@entities/workspace';

import type { Job, JobOccurrence } from '@shared/api/host';

type JobHistory = {
  occurrences: JobOccurrence[];
  nextPage: number | null;
  skipped: number;
  receivedAt: number | null;
};
type PendingReads = { job: string | null; history: { id: string; replace: boolean } | null };

const EMPTY_HISTORY: JobHistory = { occurrences: [], nextPage: null, skipped: 0, receivedAt: null };

export const useJobDetail = (jobId: string, active: boolean) => {
  const { client, connected, hostCapabilities, mode } = useWorkspace();
  const supported = mode === 'live' && hostCapabilities?.jobPages === true;
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<JobHistory>(EMPTY_HISTORY);
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState('');
  const pending = useRef<PendingReads>({ job: null, history: null });
  const historyRef = useRef(history);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const settle = useCallback(() => {
    const { job: jobRead, history: historyRead } = pending.current;
    setLoading(jobRead !== null || historyRead !== null);
  }, []);

  const readHistory = useCallback(
    (page: number, replace: boolean) => {
      const requestId = client.requestId();
      pending.current.history = { id: requestId, replace };
      if (!client.requestJobHistory(jobId, page, requestId)) pending.current.history = null;
    },
    [client, jobId],
  );

  const refresh = useCallback(() => {
    const requestId = client.requestId();
    pending.current.job = client.requestJob(jobId, requestId);
    readHistory(0, true);
    settle();
  }, [client, jobId, readHistory, settle]);

  const loadMore = useCallback(() => {
    const { nextPage, occurrences } = historyRef.current;
    const page = nextLoadablePage(nextPage, occurrences.length, MAX_LOADED_OCCURRENCES);
    if (page === null || pending.current.history) return;
    readHistory(page, false);
    settle();
  }, [readHistory, settle]);

  useEffect(
    () =>
      client.subscribe(event => {
        const reads = pending.current;
        if (event.type === 'jobDetail' && event.requestId === reads.job) {
          reads.job = null;
          setJob(event.job);
          setMissing(false);
          settle();
        } else if (
          event.type === 'jobHistory' &&
          reads.history &&
          event.requestId === reads.history.id
        ) {
          const replace = reads.history.replace;
          reads.history = null;
          setHistory(current => {
            const occurrences = mergePage(
              current.occurrences,
              event.occurrences,
              replace,
              MAX_LOADED_OCCURRENCES,
            );
            return {
              occurrences,
              nextPage: nextLoadablePage(
                event.nextPage,
                occurrences.length,
                MAX_LOADED_OCCURRENCES,
              ),
              skipped: (replace ? 0 : current.skipped) + (event.skipped ?? 0),
              receivedAt: Date.now(),
            };
          });
          settle();
        } else if (
          event.type === 'error' &&
          event.requestId &&
          (event.requestId === reads.job || event.requestId === reads.history?.id)
        ) {
          if (event.requestId === reads.job) reads.job = null;
          else reads.history = null;
          if (event.code === 'job_not_found') setMissing(true);
          else setNotice(event.message);
          settle();
        } else if (event.type === 'disconnected') {
          pending.current = { job: null, history: null };
          settle();
        }
      }),
    [client, settle],
  );

  useEffect(() => {
    if (!active || !connected || !supported || !jobId) return;
    const timer = setTimeout(refresh, 0);
    return () => clearTimeout(timer);
  }, [active, connected, supported, jobId, refresh]);

  const visible = supported ? history : EMPTY_HISTORY;
  return {
    supported,
    connected,
    job: supported ? job : null,
    missing,
    occurrences: visible.occurrences,
    lastOccurrence: visible.occurrences[0] ?? null,
    skipped: visible.skipped,
    nextPage: visible.nextPage,
    receivedAt: visible.receivedAt,
    loading,
    notice,
    dismissNotice: () => setNotice(''),
    refresh,
    loadMore,
  };
};
