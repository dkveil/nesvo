import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Computer,
  DesktopApi,
  DesktopPipelineRun,
  DesktopPipelineStepRecord,
  DesktopReview,
  DesktopSession,
  WorkspaceEvent,
} from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { entityKey, hostKey } from '@/shared/lib/host-key';

const boundApis = new Map<string, DesktopApi>();

export function desktopApi(hostId = 'local'): DesktopApi {
  const api = window.nesvo;
  if (!api)
    throw new Error(
      'The app connection is unavailable. Reload the window or reopen Nesvo.',
    );
  const existing = boundApis.get(hostId);
  if (existing) return existing;
  const bound: DesktopApi = {
    ...api,
    health: () => api.health(hostId),
    claudeStatus: () => api.claudeStatus(hostId),
    codexStatus: () => api.codexStatus(hostId),
    providerUsage: input => api.providerUsage(input, hostId),
    listSessions: () => api.listSessions(hostId),
    listReviews: () => api.listReviews(hostId),
    createSession: input => api.createSession(input, hostId),
    sendMessage: input => api.sendMessage(input, hostId),
    stopRun: input => api.stopRun(input, hostId),
    respondApproval: input => api.respondApproval(input, hostId),
    decideDelegation: input => api.decideDelegation(input, hostId),
    decideReview: input => api.decideReview(input, hostId),
    discoverSkills: input => api.discoverSkills(input, hostId),
    listWorkspaceDirectory: input => api.listWorkspaceDirectory(input, hostId),
    searchWorkspaceFiles: input => api.searchWorkspaceFiles(input, hostId),
    readWorkspaceFile: input => api.readWorkspaceFile(input, hostId),
  };
  boundApis.set(hostId, bound);
  return bound;
}

type Revisioned = { id: string; hostId: string; revision: number };

function mergeByRevision<T extends Revisioned>(previous: T[], updates: T[]) {
  const merged = new Map(previous.map(item => [entityKey(item), item]));
  let changed = false;
  for (const item of updates) {
    const current = merged.get(entityKey(item));
    if (!current || item.revision > current.revision) {
      merged.set(entityKey(item), item);
      changed = true;
    }
  }
  return changed ? [...merged.values()] : previous;
}

const emptyProviders: ProviderStates = {
  'Claude Code': { status: null, loading: false, error: '' },
  Codex: { status: null, loading: false, error: '' },
};

export function useSessions() {
  const [sessions, setSessions] = useState<DesktopSession[]>([]);
  const [reviews, setReviews] = useState<DesktopReview[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<DesktopPipelineRun[]>([]);
  const [pipelineSteps, setPipelineSteps] = useState<
    DesktopPipelineStepRecord[]
  >([]);
  const runRequests = useRef(new Set<string>());
  const [computers, setComputers] = useState<Computer[]>([]);
  const computersRef = useRef<Computer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [providersByHost, setProvidersByHost] = useState<
    Record<string, ProviderStates>
  >({});
  const [attempt, setAttempt] = useState(0);
  const statusRequests = useRef<Record<string, number>>({});
  const merge = useCallback((updates: DesktopSession[]) => {
    setSessions(previous => {
      const merged = new Map(previous.map(item => [entityKey(item), item]));
      for (const item of updates) {
        if (!computersRef.current.some(computer => computer.id === item.hostId))
          continue;
        const current = merged.get(entityKey(item));
        if (!current || item.revision > current.revision)
          merged.set(entityKey(item), item);
      }
      return [...merged.values()].sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          entityKey(a).localeCompare(entityKey(b)),
      );
    });
  }, []);
  const mergeReviews = useCallback((updates: DesktopReview[]) => {
    setReviews(previous => {
      const merged = new Map(previous.map(item => [entityKey(item), item]));
      for (const item of updates) {
        if (!computersRef.current.some(computer => computer.id === item.hostId))
          continue;
        const current = merged.get(entityKey(item));
        if (!current || item.revision > current.revision)
          merged.set(entityKey(item), item);
      }
      return [...merged.values()].sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.version - a.version ||
          entityKey(a).localeCompare(entityKey(b)),
      );
    });
  }, []);
  const mergePipelineRuns = useCallback((updates: DesktopPipelineRun[]) => {
    const known = updates.filter(item =>
      computersRef.current.some(computer => computer.id === item.hostId),
    );
    if (known.length > 0)
      setPipelineRuns(previous => mergeByRevision(previous, known));
  }, []);
  const mergePipelineSteps = useCallback(
    (updates: DesktopPipelineStepRecord[]) => {
      const known = updates.filter(item =>
        computersRef.current.some(computer => computer.id === item.hostId),
      );
      if (known.length > 0)
        setPipelineSteps(previous => mergeByRevision(previous, known));
    },
    [],
  );
  const loadPipelineRun = useCallback(
    async (hostId: string, runId: string) => {
      const key = hostKey(runId, hostId);
      if (runRequests.current.has(key)) return;
      runRequests.current.add(key);
      try {
        const detail = await window.nesvo.pipelines.getRun(hostId, runId);
        mergePipelineRuns([detail.run]);
        mergePipelineSteps(detail.steps);
      } catch {
        return;
      }
    },
    [mergePipelineRuns, mergePipelineSteps],
  );
  const inspectProvider = useCallback(
    async (provider: Provider, hostId = 'local') => {
      const key = `${hostId}/${provider}`;
      const request = (statusRequests.current[key] ?? 0) + 1;
      statusRequests.current[key] = request;
      setProvidersByHost(previous => ({
        ...previous,
        [hostId]: {
          ...(previous[hostId] ?? emptyProviders),
          [provider]: {
            ...(previous[hostId] ?? emptyProviders)[provider],
            loading: true,
            error: '',
          },
        },
      }));
      try {
        const api = desktopApi(hostId);
        const status = await (provider === 'Claude Code'
          ? api.claudeStatus()
          : api.codexStatus());
        if (statusRequests.current[key] === request)
          setProvidersByHost(previous => ({
            ...previous,
            [hostId]: {
              ...(previous[hostId] ?? emptyProviders),
              [provider]: { status, loading: false, error: '' },
            },
          }));
      } catch (failure) {
        if (statusRequests.current[key] === request)
          setProvidersByHost(previous => ({
            ...previous,
            [hostId]: {
              ...(previous[hostId] ?? emptyProviders),
              [provider]: {
                status: null,
                loading: false,
                error: `Could not check ${provider}. ${errorDetail(failure)}`,
              },
            },
          }));
      }
    },
    [],
  );
  useEffect(() => {
    const counters = statusRequests.current;
    let active = true;
    let initial = true;
    const events: WorkspaceEvent[] = [];
    let unsubscribe = () => {};
    const updateComputers = (updates: Computer[], inspect = false) => {
      const previous = computersRef.current;
      computersRef.current = updates;
      setComputers(updates);
      const ids = new Set(updates.map(item => item.id));
      setSessions(current => current.filter(item => ids.has(item.hostId)));
      setReviews(current => current.filter(item => ids.has(item.hostId)));
      setPipelineRuns(current => current.filter(item => ids.has(item.hostId)));
      setPipelineSteps(current => current.filter(item => ids.has(item.hostId)));
      for (const computer of updates) {
        if (
          computer.status === 'connected' &&
          computer.capabilities.includes('pipelines') &&
          !previous.some(
            item => item.id === computer.id && item.status === 'connected',
          )
        )
          void window.nesvo.pipelines.listRuns(computer.id, {}).then(
            page => mergePipelineRuns(page.runs),
            () => undefined,
          );
        if (
          computer.status === 'connected' &&
          (inspect ||
            !previous.some(
              item => item.id === computer.id && item.status === 'connected',
            ))
        )
          for (const provider of providers)
            void inspectProvider(provider, computer.id);
        if (computer.status !== 'connected')
          for (const provider of providers) {
            const key = `${computer.id}/${provider}`;
            statusRequests.current[key] =
              (statusRequests.current[key] ?? 0) + 1;
          }
      }
    };
    const apply = (event: WorkspaceEvent) => {
      if (event.type === 'session-changed') merge([event.session]);
      else if (event.type === 'review-changed') mergeReviews([event.review]);
      else if (event.type === 'pipeline-run-changed')
        mergePipelineRuns([event.run]);
      else if (event.type === 'pipeline-step-changed')
        mergePipelineSteps([event.step]);
      else if (event.type === 'host-snapshot') {
        for (const key of [...runRequests.current])
          if (
            event.hostId === 'local'
              ? !key.includes('/')
              : key.startsWith(`${event.hostId}/`)
          )
            runRequests.current.delete(key);
        setSessions(previous => [
          ...previous.filter(item => item.hostId !== event.hostId),
          ...event.sessions,
        ]);
        setReviews(previous => [
          ...previous.filter(item => item.hostId !== event.hostId),
          ...event.reviews,
        ]);
      } else if (event.type === 'computers-changed')
        updateComputers(event.computers);
      else if (event.type === 'host-disconnected')
        updateComputers(
          computersRef.current.map(item =>
            item.id === event.hostId
              ? { ...item, status: 'disconnected' }
              : item,
          ),
        );
    };
    try {
      const api = window.nesvo;
      if (!api)
        throw new Error(
          'The app connection is unavailable. Reload the window or reopen Nesvo.',
        );
      unsubscribe = api.subscribe(event => {
        if (!active) return;
        if (initial) events.push(event);
        else apply(event);
      });
      void Promise.all([
        api.listComputers(),
        api.listSessions(),
        api.listReviews(),
      ]).then(
        ([hosts, history, results]) => {
          if (!active) return;
          setSessions(history);
          setReviews(results);
          updateComputers(hosts, true);
          initial = false;
          for (const event of events) apply(event);
          setError('');
          setLoading(false);
        },
        failure => {
          if (!active) return;
          initial = false;
          for (const event of events) apply(event);
          setError(`Could not refresh the workspace. ${errorDetail(failure)}`);
          setLoading(false);
        },
      );
    } catch (failure) {
      queueMicrotask(() => {
        if (active) {
          setError(errorDetail(failure));
          setLoading(false);
        }
      });
    }
    return () => {
      active = false;
      for (const key of Object.keys(counters))
        counters[key] = (counters[key] ?? 0) + 1;
      unsubscribe();
    };
  }, [
    attempt,
    inspectProvider,
    merge,
    mergeReviews,
    mergePipelineRuns,
    mergePipelineSteps,
  ]);
  useEffect(() => {
    if (loading) return;
    for (const session of sessions)
      if (
        session.pipelineRunId &&
        computers.some(
          computer =>
            computer.id === session.hostId && computer.status === 'connected',
        )
      )
        void loadPipelineRun(session.hostId, session.pipelineRunId);
  }, [sessions, computers, loading, loadPipelineRun]);
  const reload = () => {
    setLoading(true);
    setAttempt(value => value + 1);
  };
  const refresh = async (hostId = 'local') => {
    try {
      await window.nesvo.connectComputer(hostId);
      for (const provider of providers) void inspectProvider(provider, hostId);
    } catch {
      return;
    }
  };
  const recover = async (hostId?: string) => {
    const history = await window.nesvo.listSessions(hostId);
    merge(history);
    return history;
  };
  const recoverReviews = async (hostId?: string) => {
    const history = await window.nesvo.listReviews(hostId);
    mergeReviews(history);
    return history;
  };
  const hostReady = (hostId = 'local') =>
    !loading &&
    !error &&
    computers.some(item => item.id === hostId && item.status === 'connected');
  const providerStates = (hostId = 'local') =>
    providersByHost[hostId] ?? emptyProviders;
  return {
    sessions,
    reviews,
    pipelineRuns,
    pipelineSteps,
    mergePipelineRuns,
    computers,
    loading,
    error,
    reviewsLoading: loading,
    reviewsError: error,
    hostReady,
    providerStates,
    merge,
    mergeReviews,
    recover,
    recoverReviews,
    refresh,
    reload,
    refreshProvider: inspectProvider,
  };
}
