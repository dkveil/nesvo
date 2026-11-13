import { useCallback, useEffect, useRef, useState } from 'react';
import type { Computer } from '@nesvo/contracts';
import {
  sortRuns,
  type ScheduledJob,
  type ScheduledJobRun,
} from '@/entities/scheduled-job';
import { errorDetail } from '@/entities/session';
import { entityKey, hostKey } from '@/shared/lib/host-key';

export type JobRuns = {
  runs: ScheduledJobRun[];
  nextCursor: string | null;
  loading: boolean;
  error: string;
};

const emptyRuns: JobRuns = {
  runs: [],
  nextCursor: null,
  loading: false,
  error: '',
};

export const supportsScheduledJobs = (computer: Computer | undefined) =>
  !!computer?.capabilities.includes('scheduled-jobs');

const sortJobs = (jobs: ScheduledJob[]) =>
  jobs.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      entityKey(left).localeCompare(entityKey(right)),
  );

export function useScheduledJobs(computers: Computer[]) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runs, setRuns] = useState<Record<string, JobRuns>>({});
  const [hostErrors, setHostErrors] = useState<Record<string, string>>({});
  const [loadingHosts, setLoadingHosts] = useState<string[]>([]);
  const loadedHosts = useRef(new Map<string, number>());
  const requests = useRef<Record<string, number>>({});
  const mergeJobs = useCallback((updates: ScheduledJob[]) => {
    setJobs(previous => {
      const merged = new Map(previous.map(item => [entityKey(item), item]));
      for (const item of updates) {
        const current = merged.get(entityKey(item));
        if (!current || item.revision > current.revision)
          merged.set(entityKey(item), item);
      }
      return sortJobs([...merged.values()]);
    });
  }, []);
  const mergeRuns = useCallback((updates: ScheduledJobRun[]) => {
    setRuns(previous => {
      const next = { ...previous };
      for (const run of updates) {
        const key = hostKey(run.scheduledJobId, run.hostId);
        const entry = next[key] ?? emptyRuns;
        next[key] = {
          ...entry,
          runs: sortRuns([
            run,
            ...entry.runs.filter(item => item.id !== run.id),
          ]),
        };
      }
      return next;
    });
  }, []);
  const loadRuns = useCallback(
    async (job: ScheduledJob, cursor: string | null = null) => {
      const key = entityKey(job);
      const more = cursor !== null;
      const request = (requests.current[key] ?? 0) + 1;
      requests.current[key] = request;
      setRuns(previous => ({
        ...previous,
        [key]: { ...(previous[key] ?? emptyRuns), loading: true, error: '' },
      }));
      try {
        const page = await window.nesvo.scheduledJobs.listRuns(
          job.hostId,
          job.id,
          cursor,
        );
        if (requests.current[key] !== request) return;
        setRuns(previous => {
          const entry = previous[key] ?? emptyRuns;
          const known = more
            ? entry.runs
            : entry.runs.filter(
                run => !page.runs.some(item => item.id === run.id),
              );
          return {
            ...previous,
            [key]: {
              runs: sortRuns([
                ...page.runs,
                ...known.filter(
                  run => !page.runs.some(item => item.id === run.id),
                ),
              ]),
              nextCursor: page.nextCursor,
              loading: false,
              error: '',
            },
          };
        });
      } catch (failure) {
        if (requests.current[key] !== request) return;
        setRuns(previous => ({
          ...previous,
          [key]: {
            ...(previous[key] ?? emptyRuns),
            loading: false,
            error: `Could not load the runs. ${errorDetail(failure)}`,
          },
        }));
      }
    },
    [],
  );
  const loadHost = useCallback(
    async (hostId: string) => {
      setLoadingHosts(previous => [
        ...previous.filter(id => id !== hostId),
        hostId,
      ]);
      try {
        const list = await window.nesvo.scheduledJobs.list(hostId);
        setJobs(previous =>
          sortJobs([...previous.filter(job => job.hostId !== hostId), ...list]),
        );
        setHostErrors(previous => ({ ...previous, [hostId]: '' }));
        await Promise.all(list.map(job => loadRuns(job)));
      } catch (failure) {
        setHostErrors(previous => ({
          ...previous,
          [hostId]: `Could not load automations. ${errorDetail(failure)}`,
        }));
      } finally {
        setLoadingHosts(previous => previous.filter(id => id !== hostId));
      }
    },
    [loadRuns],
  );
  useEffect(() => {
    const ready = computers.filter(
      computer =>
        computer.status === 'connected' && supportsScheduledJobs(computer),
    );
    for (const computer of ready) {
      const generation = computer.lastSyncedAt
        ? Date.parse(computer.lastSyncedAt)
        : 0;
      if (loadedHosts.current.get(computer.id) === generation) continue;
      loadedHosts.current.set(computer.id, generation);
      void loadHost(computer.id);
    }
    for (const hostId of [...loadedHosts.current.keys()])
      if (!ready.some(computer => computer.id === hostId))
        loadedHosts.current.delete(hostId);
    const known = new Set(computers.map(computer => computer.id));
    setJobs(previous =>
      previous.some(job => !known.has(job.hostId))
        ? previous.filter(job => known.has(job.hostId))
        : previous,
    );
  }, [computers, loadHost]);
  useEffect(() => {
    const api = window.nesvo;
    if (!api) return;
    return api.subscribe(event => {
      if (event.type === 'scheduled-job-changed')
        mergeJobs([event.scheduledJob]);
      else if (event.type === 'scheduled-job-removed')
        setJobs(previous =>
          previous.filter(
            job =>
              !(
                job.id === event.scheduledJobId &&
                job.hostId === event.hostId &&
                job.revision < event.revision
              ),
          ),
        );
      else if (event.type === 'scheduled-job-run-changed')
        mergeRuns([event.run]);
      else if (event.type === 'host-snapshot') {
        loadedHosts.current.delete(event.hostId);
        void loadHost(event.hostId);
      }
    });
  }, [loadHost, mergeJobs, mergeRuns]);
  const removeJob = (job: ScheduledJob) =>
    setJobs(previous =>
      previous.filter(item => entityKey(item) !== entityKey(job)),
    );
  return {
    jobs,
    runs: (job: Pick<ScheduledJob, 'id' | 'hostId'>) =>
      runs[entityKey(job)] ?? emptyRuns,
    hostErrors,
    loading: loadingHosts.length > 0,
    mergeJobs,
    mergeRuns,
    removeJob,
    loadRuns,
    reload: loadHost,
  };
}
