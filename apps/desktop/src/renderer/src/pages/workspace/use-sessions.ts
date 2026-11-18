import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applySessionChange,
  hasEarlierMessages,
  prependSessionMessages,
  sessionHistoryLimits,
  trimSessionWindow,
  type DesktopSessionMessageUpsert,
  type SessionChange,
} from '@nesvo/contracts';
import type {
  AssistantChange,
  AssistantChangeRefusal,
  Computer,
  DesktopApi,
  DesktopWorkflowRun,
  DesktopWorkflowStepRecord,
  DesktopReview,
  DesktopSession,
  SessionGroupList,
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
    claudeStatus: (_hostId, input) => api.claudeStatus(hostId, input),
    codexStatus: (_hostId, input) => api.codexStatus(hostId, input),
    providerUsage: input => api.providerUsage(input, hostId),
    listProviderProfiles: () => api.listProviderProfiles(hostId),
    createProviderProfile: input => api.createProviderProfile(input, hostId),
    renameProviderProfile: input => api.renameProviderProfile(input, hostId),
    removeProviderProfile: input => api.removeProviderProfile(input, hostId),
    listSessions: () => api.listSessions(hostId),
    getSession: input => api.getSession(input, hostId),
    readSessionMessages: input => api.readSessionMessages(input, hostId),
    listConversations: input => api.listConversations(input, hostId),
    searchTranscripts: input => api.searchTranscripts(input, hostId),
    openSessionInTerminal: input => api.openSessionInTerminal(input, hostId),
    setSessionTerminal: input => api.setSessionTerminal(input, hostId),
    adoptConversation: input => api.adoptConversation(input, hostId),
    listReviews: () => api.listReviews(hostId),
    createSession: input => api.createSession(input, hostId),
    readSessionWorktree: input => api.readSessionWorktree(input, hostId),
    finishSessionWorktree: input => api.finishSessionWorktree(input, hostId),
    readSessionWorktreeSetup: input =>
      api.readSessionWorktreeSetup(input, hostId),
    runSessionWorktreeSetup: input =>
      api.runSessionWorktreeSetup(input, hostId),
    sendMessage: input => api.sendMessage(input, hostId),
    stopRun: input => api.stopRun(input, hostId),
    respondApproval: input => api.respondApproval(input, hostId),
    decideDelegation: input => api.decideDelegation(input, hostId),
    decideReview: input => api.decideReview(input, hostId),
    discoverSkills: input => api.discoverSkills(input, hostId),
    listMcpServers: input => api.listMcpServers(input, hostId),
    readGitBranch: input => api.readGitBranch(input, hostId),
    listWorkspaceDirectory: input => api.listWorkspaceDirectory(input, hostId),
    searchWorkspaceFiles: input => api.searchWorkspaceFiles(input, hostId),
    readWorkspaceFile: input => api.readWorkspaceFile(input, hostId),
    readSessionChanges: input => api.readSessionChanges(input, hostId),
    readSessionChangePatch: input => api.readSessionChangePatch(input, hostId),
    stageAttachment: input => api.stageAttachment(input, hostId),
    readAttachment: input => api.readAttachment(input, hostId),
    openAttachment: input => api.openAttachment(input, hostId),
    listPullRequests: input => api.listPullRequests(input, hostId),
    readPullRequest: input => api.readPullRequest(input, hostId),
    readPullRequestFiles: input => api.readPullRequestFiles(input, hostId),
    readPullRequestThreads: input => api.readPullRequestThreads(input, hostId),
    actOnPullRequest: input => api.actOnPullRequest(input, hostId),
    linkSessionPullRequest: input => api.linkSessionPullRequest(input, hostId),
    findSessionPullRequest: input => api.findSessionPullRequest(input, hostId),
    readCodeReviewSettings: () => api.readCodeReviewSettings(hostId),
    saveReviewerProfile: input => api.saveReviewerProfile(input, hostId),
    deleteReviewerProfile: input => api.deleteReviewerProfile(input, hostId),
    saveReviewConvention: input => api.saveReviewConvention(input, hostId),
    deleteReviewConvention: input => api.deleteReviewConvention(input, hostId),
    startPullRequestReview: input => api.startPullRequestReview(input, hostId),
    listPullRequestReviews: input => api.listPullRequestReviews(input, hostId),
    updateReviewFinding: input => api.updateReviewFinding(input, hostId),
    discardPullRequestReview: input =>
      api.discardPullRequestReview(input, hostId),
    publishPullRequestReview: input =>
      api.publishPullRequestReview(input, hostId),
    listSessionGroups: () => api.listSessionGroups(hostId),
    createSessionGroup: input => api.createSessionGroup(input, hostId),
    updateSessionGroup: input => api.updateSessionGroup(input, hostId),
    moveSessionGroup: input => api.moveSessionGroup(input, hostId),
    deleteSessionGroup: input => api.deleteSessionGroup(input, hostId),
    moveSession: input => api.moveSession(input, hostId),
    renameSession: input => api.renameSession(input, hostId),
    setSessionPinned: input => api.setSessionPinned(input, hostId),
    setSessionArchived: input => api.setSessionArchived(input, hostId),
    deleteSession: input => api.deleteSession(input, hostId),
    restoreSession: input => api.restoreSession(input, hostId),
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

const OPEN_SESSION_WINDOWS = 4;

const sortSessions = (sessions: Iterable<DesktopSession>) =>
  [...sessions].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      entityKey(a).localeCompare(entityKey(b)),
  );

const upsertChange = (
  event: DesktopSessionMessageUpsert,
): SessionChange<DesktopSession> => ({ ...event, type: 'upsert' });

const emptyProviders: ProviderStates = {
  'Claude Code': { status: null, loading: false, error: '' },
  Codex: { status: null, loading: false, error: '' },
};

export function useSessions() {
  const [sessions, setSessions] = useState<DesktopSession[]>([]);
  const [reviews, setReviews] = useState<DesktopReview[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<DesktopWorkflowRun[]>([]);
  const [workflowSteps, setWorkflowSteps] = useState<
    DesktopWorkflowStepRecord[]
  >([]);
  const [assistantProposals, setAssistantProposals] = useState<
    Record<
      string,
      Extract<WorkspaceEvent, { type: 'workflow-assistant-proposal' }>
    >
  >({});
  const [assistantChanges, setAssistantChanges] = useState<
    Record<string, AssistantChange[]>
  >({});
  const [assistantRefusals, setAssistantRefusals] = useState<
    Record<string, AssistantChangeRefusal[]>
  >({});
  const recordAssistantChange = useCallback(
    (hostId: string, change: AssistantChange) =>
      setAssistantChanges(previous => {
        const list = previous[hostId] ?? [];
        const rest = list.filter(item => item.changeId !== change.changeId);
        return {
          ...previous,
          [hostId]: [...rest, change].sort(
            (left, right) =>
              left.at.localeCompare(right.at) || left.sequence - right.sequence,
          ),
        };
      }),
    [],
  );
  const [groupLists, setGroupLists] = useState<
    Record<string, SessionGroupList>
  >({});
  const mergeGroups = useCallback((hostId: string, list: SessionGroupList) => {
    if (!computersRef.current.some(computer => computer.id === hostId)) return;
    setGroupLists(previous =>
      (previous[hostId]?.revision ?? -1) > list.revision
        ? previous
        : { ...previous, [hostId]: list },
    );
  }, []);
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
  const sessionsRef = useRef<DesktopSession[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const openKeys = useRef<string[]>([]);
  const staleKeys = useRef(new Set<string>());
  const historyRequests = useRef(new Map<string, Promise<void>>());
  const refreshStale = useRef(() => {});
  const loadLatest = useCallback(async (session: DesktopSession) => {
    const key = entityKey(session);
    const pending = historyRequests.current.get(key);
    if (pending) return pending;
    const request = window.nesvo
      .getSession({ sessionId: session.id }, session.hostId)
      .then(
        loaded =>
          setSessions(previous =>
            previous.map(item => {
              if (entityKey(item) !== key) return item;
              if (item.revision <= loaded.revision) return loaded;
              const applied = applySessionChange(loaded, {
                type: 'snapshot',
                session: item,
              });
              return applied && !applied.gap ? applied.session : item;
            }),
          ),
        () => undefined,
      )
      .finally(() => {
        historyRequests.current.delete(key);
        if (staleKeys.current.size > 0)
          queueMicrotask(() => refreshStale.current());
      });
    historyRequests.current.set(key, request);
    return request;
  }, []);
  useEffect(() => {
    refreshStale.current = () => {
      const keys = [...staleKeys.current];
      staleKeys.current.clear();
      for (const key of keys) {
        if (!openKeys.current.includes(key)) continue;
        const session = sessionsRef.current.find(
          item => entityKey(item) === key,
        );
        if (session) void loadLatest(session);
      }
    };
  }, [loadLatest]);
  const applyChanges = useCallback(
    (changes: SessionChange<DesktopSession>[]) => {
      setSessions(previous => {
        const merged = new Map(previous.map(item => [entityKey(item), item]));
        let changed = false;
        for (const change of changes) {
          const hostId = change.session.hostId;
          if (!computersRef.current.some(computer => computer.id === hostId))
            continue;
          const key = entityKey(change.session);
          const applied = applySessionChange(merged.get(key), change);
          if (!applied) continue;
          if (applied.gap) staleKeys.current.add(key);
          merged.set(key, applied.session);
          changed = true;
        }
        return changed ? sortSessions(merged.values()) : previous;
      });
      queueMicrotask(() => refreshStale.current());
    },
    [],
  );
  const merge = useCallback(
    (updates: DesktopSession[]) =>
      applyChanges(
        updates.map(session => ({ type: 'snapshot', session }) as const),
      ),
    [applyChanges],
  );
  const openSession = useCallback(
    (key: string) => {
      const next = [key, ...openKeys.current.filter(item => item !== key)];
      const closed = new Set(next.slice(OPEN_SESSION_WINDOWS));
      openKeys.current = next.slice(0, OPEN_SESSION_WINDOWS);
      if (closed.size > 0)
        setSessions(previous =>
          previous.map(item =>
            closed.has(entityKey(item)) ? trimSessionWindow(item) : item,
          ),
        );
      const session = sessionsRef.current.find(item => entityKey(item) === key);
      if (
        session &&
        session.messages.length < sessionHistoryLimits.page &&
        hasEarlierMessages(session)
      )
        void loadLatest(session);
    },
    [loadLatest],
  );
  const loadEarlier = useCallback(async (key: string) => {
    const session = sessionsRef.current.find(item => entityKey(item) === key);
    const cursor = session?.messages[0]?.id;
    if (!session || !cursor || !hasEarlierMessages(session)) return false;
    const page = await window.nesvo.readSessionMessages(
      { sessionId: session.id, cursor },
      session.hostId,
    );
    setSessions(previous =>
      previous.map(item => {
        if (entityKey(item) !== key) return item;
        return prependSessionMessages(item, page) ?? item;
      }),
    );
    return page.messages.length > 0;
  }, []);
  const remove = useCallback((hostId: string, sessionIds: string[]) => {
    const removed = new Set(sessionIds.map(id => hostKey(id, hostId)));
    setSessions(previous =>
      previous.some(item => removed.has(entityKey(item)))
        ? previous.filter(item => !removed.has(entityKey(item)))
        : previous,
    );
    setReviews(previous =>
      previous.some(item => removed.has(hostKey(item.sessionId, item.hostId)))
        ? previous.filter(
            item => !removed.has(hostKey(item.sessionId, item.hostId)),
          )
        : previous,
    );
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
  const mergeWorkflowRuns = useCallback((updates: DesktopWorkflowRun[]) => {
    const known = updates.filter(item =>
      computersRef.current.some(computer => computer.id === item.hostId),
    );
    if (known.length > 0)
      setWorkflowRuns(previous => mergeByRevision(previous, known));
  }, []);
  const mergeWorkflowSteps = useCallback(
    (updates: DesktopWorkflowStepRecord[]) => {
      const known = updates.filter(item =>
        computersRef.current.some(computer => computer.id === item.hostId),
      );
      if (known.length > 0)
        setWorkflowSteps(previous => mergeByRevision(previous, known));
    },
    [],
  );
  const loadWorkflowRun = useCallback(
    async (hostId: string, runId: string) => {
      const key = hostKey(runId, hostId);
      if (runRequests.current.has(key)) return;
      runRequests.current.add(key);
      try {
        const detail = await window.nesvo.workflows.getRun(hostId, runId);
        mergeWorkflowRuns([detail.run]);
        mergeWorkflowSteps(detail.steps);
      } catch {
        runRequests.current.delete(key);
      }
    },
    [mergeWorkflowRuns, mergeWorkflowSteps],
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
      setWorkflowRuns(current => current.filter(item => ids.has(item.hostId)));
      setWorkflowSteps(current => current.filter(item => ids.has(item.hostId)));
      setGroupLists(current =>
        Object.fromEntries(
          Object.entries(current).filter(([hostId]) => ids.has(hostId)),
        ),
      );
      for (const computer of updates) {
        if (
          computer.status === 'connected' &&
          computer.capabilities.includes('session-groups') &&
          !previous.some(
            item => item.id === computer.id && item.status === 'connected',
          )
        )
          void window.nesvo.listSessionGroups(computer.id).then(
            list => mergeGroups(computer.id, list),
            () => undefined,
          );
        if (
          computer.status === 'connected' &&
          computer.capabilities.includes('workflows') &&
          !previous.some(
            item => item.id === computer.id && item.status === 'connected',
          )
        )
          void window.nesvo.workflows.listRuns(computer.id, {}).then(
            page => mergeWorkflowRuns(page.runs),
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
      else if (event.type === 'session-message-upserted')
        applyChanges([upsertChange(event)]);
      else if (event.type === 'review-changed') mergeReviews([event.review]);
      else if (event.type === 'sessions-removed')
        remove(event.hostId, event.sessionIds);
      else if (event.type === 'workflow-run-changed')
        mergeWorkflowRuns([event.run]);
      else if (event.type === 'workflow-step-changed')
        mergeWorkflowSteps([event.step]);
      else if (event.type === 'session-groups-changed')
        mergeGroups(event.hostId, event.list);
      else if (event.type === 'workflow-assistant-proposal')
        setAssistantProposals(previous => ({
          ...previous,
          [hostKey(event.messageId, event.hostId)]: event,
        }));
      else if (event.type === 'workflow-assistant-change')
        recordAssistantChange(event.hostId, event.change);
      else if (event.type === 'workflow-assistant-change-refused')
        setAssistantRefusals(previous => ({
          ...previous,
          [event.hostId]: [
            ...(previous[event.hostId] ?? []),
            event.refusal,
          ].slice(-200),
        }));
      else if (event.type === 'host-snapshot') {
        for (const key of [...runRequests.current])
          if (
            event.hostId === 'local'
              ? !key.includes('/')
              : key.startsWith(`${event.hostId}/`)
          )
            runRequests.current.delete(key);
        setSessions(previous => {
          const known = new Map(
            previous
              .filter(item => item.hostId === event.hostId)
              .map(item => [entityKey(item), item]),
          );
          return sortSessions([
            ...previous.filter(item => item.hostId !== event.hostId),
            ...event.sessions.map(session => {
              const current = known.get(entityKey(session));
              if (!current) return session;
              return (
                applySessionChange(current, { type: 'snapshot', session })
                  ?.session ?? current
              );
            }),
          ]);
        });
        for (const key of openKeys.current)
          if (
            event.hostId === 'local'
              ? !key.includes('/')
              : key.startsWith(`${event.hostId}/`)
          )
            staleKeys.current.add(key);
        queueMicrotask(() => refreshStale.current());
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
    mergeGroups,
    recordAssistantChange,
    inspectProvider,
    merge,
    applyChanges,
    remove,
    mergeReviews,
    mergeWorkflowRuns,
    mergeWorkflowSteps,
  ]);
  useEffect(() => {
    if (loading) return;
    for (const session of sessions)
      if (
        session.workflowRunId &&
        computers.some(
          computer =>
            computer.id === session.hostId && computer.status === 'connected',
        )
      )
        void loadWorkflowRun(session.hostId, session.workflowRunId);
  }, [sessions, computers, loading, loadWorkflowRun]);
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
  const groups = (hostId: string) => groupLists[hostId]?.groups ?? [];
  const supportsGroups = (hostId: string) =>
    !!computers
      .find(computer => computer.id === hostId)
      ?.capabilities.includes('session-groups');
  return {
    sessions,
    groups,
    groupLists,
    mergeGroups,
    supportsGroups,
    reviews,
    workflowRuns,
    workflowSteps,
    assistantProposals,
    assistantChanges,
    assistantRefusals,
    recordAssistantChange,
    mergeWorkflowRuns,
    computers,
    loading,
    error,
    reviewsLoading: loading,
    reviewsError: error,
    hostReady,
    providerStates,
    merge,
    openSession,
    loadEarlier,
    remove,
    mergeReviews,
    recover,
    recoverReviews,
    refresh,
    reload,
    refreshProvider: inspectProvider,
  };
}
