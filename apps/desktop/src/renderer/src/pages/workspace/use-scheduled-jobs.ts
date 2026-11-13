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

const isReady = (computer: Computer) =>
  computer.status === 'connected' && supportsScheduledJobs(computer);

export function useScheduledJobs(computers: Computer[]) {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runs, setRuns] = useState<Record<string, JobRuns>>({});
  const [hostErrors, setHostErrors] = useState<Record<string, string>>({});
  const [loadingHosts, setLoadingHosts] = useState<string[]>([]);
  const loadedHosts = useRef(new Map<string, string>());
  const hostRequests = useRef<Record<string, number>>({});
  const runRequests = useRef<Record<string, number>>({});
  const changeCount = useRef(0);
  const changedAt = useRef(new Map<string, number>());
  const removed = useRef(new Map<string, number>());
  const noteChange = (key: string) => {
    changeCount.current += 1;
    changedAt.current.set(key, changeCount.current);
  };
  const mergeJobs = useCallback((updates: ScheduledJob[]) => {
    for (const item of updates) noteChange(entityKey(item));
    setJobs(previous => {
      const merged = new Map(previous.map(item => [entityKey(item), item]));
      for (const item of updates) {
        const key = entityKey(item);
        const current = merged.get(key);
        if ((removed.current.get(key) ?? 0) > item.revision) continue;
        if (!current || item.revision > current.revision) merged.set(key, item);
      }
      return sortJobs([...merged.values()]);
    });
  }, []);
  const removeJob = useCallback(
    (job: Pick<ScheduledJob, 'id' | 'hostId'>, revision: number) => {
      const key = entityKey(job);
      noteChange(key);
      removed.current.set(
        key,
        Math.max(removed.current.get(key) ?? 0, revision),
      );
      setJobs(previous =>
        previous.filter(
          item => entityKey(item) !== key || item.revision >= revision,
        ),
      );
    },
    [],
  );
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
      const request = (runRequests.current[key] ?? 0) + 1;
      runRequests.current[key] = request;
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
        if (runRequests.current[key] !== request) return;
        setRuns(previous => {
          const entry = previous[key] ?? emptyRuns;
          const known = entry.runs.filter(
            run => !page.runs.some(item => item.id === run.id),
          );
          return {
            ...previous,
            [key]: {
              runs: sortRuns([...page.runs, ...known]),
              nextCursor:
                more || !entry.nextCursor ? page.nextCursor : entry.nextCursor,
              loading: false,
              error: '',
            },
          };
        });
      } catch (failure) {
        if (runRequests.current[key] !== request) return;
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
      const request = (hostRequests.current[hostId] ?? 0) + 1;
      hostRequests.current[hostId] = request;
      const startedAt = changeCount.current;
      const current = () => hostRequests.current[hostId] === request;
      setLoadingHosts(previous => [
        ...previous.filter(id => id !== hostId),
        hostId,
      ]);
      try {
        const list = await window.nesvo.scheduledJobs.list(hostId);
        if (!current()) return;
        setJobs(previous => {
          const listed = new Map(list.map(job => [entityKey(job), job]));
          const kept = previous.filter(job => {
            if (job.hostId !== hostId) return true;
            const key = entityKey(job);
            const fresh = listed.get(key);
            if (fresh) return job.revision > fresh.revision;
            return (changedAt.current.get(key) ?? 0) > startedAt;
          });
          const keptKeys = new Set(kept.map(entityKey));
          const added = list.filter(
            job =>
              !keptKeys.has(entityKey(job)) &&
              (removed.current.get(entityKey(job)) ?? 0) <= job.revision,
          );
          return sortJobs([...kept, ...added]);
        });
        setHostErrors(previous => ({ ...previous, [hostId]: '' }));
        await Promise.all(list.map(job => loadRuns(job)));
      } catch (failure) {
        if (!current()) return;
        setHostErrors(previous => ({
          ...previous,
          [hostId]: `Could not load automations. ${errorDetail(failure)}`,
        }));
      } finally {
        if (current())
          setLoadingHosts(previous => previous.filter(id => id !== hostId));
      }
    },
    [loadRuns],
  );
  useEffect(() => {
    const ready = computers.filter(isReady);
    for (const computer of ready) {
      const generation = computer.lastSyncedAt ?? computer.instanceId ?? '';
      if (loadedHosts.current.get(computer.id) === generation) continue;
      loadedHosts.current.set(computer.id, generation);
      void loadHost(computer.id);
    }
    for (const hostId of [...loadedHosts.current.keys()])
      if (!ready.some(computer => computer.id === hostId)) {
        loadedHosts.current.delete(hostId);
        hostRequests.current[hostId] = (hostRequests.current[hostId] ?? 0) + 1;
      }
    const readyIds = new Set(ready.map(computer => computer.id));
    setLoadingHosts(previous =>
      previous.some(id => !readyIds.has(id))
        ? previous.filter(id => readyIds.has(id))
        : previous,
    );
    setHostErrors(previous =>
      Object.keys(previous).some(id => !readyIds.has(id))
        ? Object.fromEntries(
            Object.entries(previous).filter(([id]) => readyIds.has(id)),
          )
        : previous,
    );
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
        removeJob(
          { id: event.scheduledJobId, hostId: event.hostId },
          event.revision,
        );
      else if (event.type === 'scheduled-job-run-changed')
        mergeRuns([event.run]);
    });
  }, [mergeJobs, mergeRuns, removeJob]);
  return {
    jobs,
    runs: (job: Pick<ScheduledJob, 'id' | 'hostId'>) =>
      runs[entityKey(job)] ?? emptyRuns,
    hostErrors,
    loading: loadingHosts.length > 0,
    mergeJobs,
    mergeRuns,
    removeJob: (job: ScheduledJob) => removeJob(job, job.revision + 1),
    loadRuns,
    reload: loadHost,
  };
}
