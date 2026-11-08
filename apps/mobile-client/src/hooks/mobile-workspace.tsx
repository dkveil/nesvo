import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { randomUUID } from 'expo-crypto';
import type {
  DesktopSession,
  MobileCommand,
  MobileSnapshot,
} from '@nesvo/contracts';
import {
  command,
  GatewayError,
  openEvents,
  pairDevice,
  snapshot,
} from '@/utils/gateway-client';
import {
  forgetConnection,
  loadConnections,
  saveConnection,
  type Connection,
} from '@/utils/connections';

type Status =
  'connecting' | 'connected' | 'offline' | 'revoked' | 'unauthorized' | 'error';
type Draft = { text: string; version: number };
type SendAttempt = { text: string; messageId: string; id: string };
const keyFor = (connectionId: string, hostId: string, id: string) =>
  `${connectionId}/${hostId}/${id}`;
const terminalCodes = new Set([
  'revoked',
  'unauthorized',
  'server-mismatch',
  'protocol-mismatch',
  'too-large',
]);
const failureStatus = (error: GatewayError): Status =>
  error.code === 'revoked'
    ? 'revoked'
    : error.code === 'unauthorized'
      ? 'unauthorized'
      : terminalCodes.has(error.code)
        ? 'error'
        : 'offline';

function useWorkspaceState() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState('');
  const [views, setViews] = useState<Record<string, MobileSnapshot>>({});
  const [statuses, setStatuses] = useState<
    Record<string, { status: Status; error: string }>
  >({});
  const [attempt, setAttempt] = useState(0);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const draftsRef = useRef<Record<string, Draft>>({});
  const sendAttempts = useRef<Record<string, SendAttempt>>({});
  const requests = useRef(new Set<string>());
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const selected = connections.find(connection => connection.id === selectedId);
  const view = selected ? views[selected.id] : undefined;
  const connectionState = statuses[selectedId] ?? {
    status: 'offline' as Status,
    error: '',
  };
  const connectionsRef = useRef(connections);
  const connectionMutations = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef({ value: 0 });
  const terminalFailures = useRef(new Map<string, GatewayError>());
  const activeStream = useRef<{
    connectionId: string;
    generation: number;
    fail: (error: GatewayError) => void;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void loadConnections().then(
      values => {
        if (!current) return;
        connectionsRef.current = values;
        setConnections(values);
        setSelectedId(values[0]?.id ?? '');
        setLoading(false);
      },
      () => {
        if (current) {
          setStorageError(
            'Saved connections could not be read from secure storage. Retry after unlocking your device.',
          );
          setLoading(false);
        }
      },
    );
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state =>
      setForeground(state === 'active'),
    );
    return () => subscription.remove();
  }, []);
  const merge = useCallback((connectionId: string, session: DesktopSession) => {
    setViews(previous => {
      const current = previous[connectionId];
      if (!current) return previous;
      const found = current.sessions.find(
        item => item.id === session.id && item.hostId === session.hostId,
      );
      if (found && found.revision >= session.revision) return previous;
      return {
        ...previous,
        [connectionId]: {
          ...current,
          sessions: [
            ...current.sessions.filter(
              item => item.id !== session.id || item.hostId !== session.hostId,
            ),
            session,
          ],
        },
      };
    });
  }, []);
  useEffect(() => {
    if (!selected) return;
    const clock = generation.current;
    const current = ++clock.value;
    let disconnect = () => {};
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let sequence = -1;
    let blocked = false;
    const connectionId = selected.id;
    const updateStatus = (status: Status, error = '') => {
      if (clock.value === current)
        setStatuses(previous => ({
          ...previous,
          [connectionId]: { status, error },
        }));
    };
    const terminalFailure = terminalFailures.current.get(connectionId);
    if (terminalFailure) {
      queueMicrotask(() =>
        updateStatus(failureStatus(terminalFailure), terminalFailure.message),
      );
      return () => {
        ++clock.value;
      };
    }
    if (!foreground) {
      queueMicrotask(() =>
        updateStatus(
          'offline',
          'The app is in the background. Return to refresh its state.',
        ),
      );
      return () => {
        ++clock.value;
      };
    }
    const fail = (error: GatewayError) => {
      if (clock.value !== current || blocked) return;
      if (terminalCodes.has(error.code)) {
        blocked = true;
        terminalFailures.current.set(connectionId, error);
      }
      updateStatus(failureStatus(error), error.message);
      if (blocked) {
        if (reconnect) clearTimeout(reconnect);
        disconnect();
        if (activeStream.current?.generation === current)
          activeStream.current = null;
        ++clock.value;
      }
    };
    activeStream.current = { connectionId, generation: current, fail };
    queueMicrotask(() => {
      if (clock.value !== current) return;
      updateStatus('connecting');
      disconnect = openEvents(
        selected,
        message => {
          if (clock.value !== current || blocked || message.type === 'error')
            return;
          if (message.type === 'snapshot') {
            if (message.serverId !== selected.serverId) {
              fail(
                new GatewayError(
                  'server-mismatch',
                  'The gateway identity changed. Pair this connection again.',
                ),
              );
              disconnect();
              return;
            }
            sequence = message.sequence;
            const { serverId, computers, sessions } = message;
            setViews(previous => ({
              ...previous,
              [connectionId]: { serverId, sequence, computers, sessions },
            }));
            updateStatus('connected');
            return;
          }
          if (sequence < 0 || message.sequence !== sequence + 1) {
            updateStatus(
              'offline',
              'The event stream changed. Reconnecting to refresh the authoritative history.',
            );
            disconnect();
            reconnect = setTimeout(() => {
              if (clock.value === current) setAttempt(value => value + 1);
            }, 500);
            return;
          }
          sequence = message.sequence;
          if (message.type === 'session-changed')
            merge(connectionId, message.session);
          else if (message.type === 'computers-changed')
            setViews(previous => {
              const data = previous[connectionId];
              return data
                ? {
                    ...previous,
                    [connectionId]: {
                      ...data,
                      sequence,
                      computers: message.computers,
                      sessions: data.sessions.filter(session =>
                        message.computers.some(
                          computer => computer.id === session.hostId,
                        ),
                      ),
                    },
                  }
                : previous;
            });
          else if (message.type === 'host-snapshot')
            setViews(previous => {
              const data = previous[connectionId];
              return data
                ? {
                    ...previous,
                    [connectionId]: {
                      ...data,
                      sequence,
                      sessions: [
                        ...data.sessions.filter(
                          session => session.hostId !== message.hostId,
                        ),
                        ...message.sessions,
                      ],
                    },
                  }
                : previous;
            });
          else if (message.type === 'host-disconnected')
            setViews(previous => {
              const data = previous[connectionId];
              return data
                ? {
                    ...previous,
                    [connectionId]: {
                      ...data,
                      sequence,
                      computers: data.computers.map(computer =>
                        computer.id === message.hostId
                          ? { ...computer, status: 'disconnected' }
                          : computer,
                      ),
                    },
                  }
                : previous;
            });
        },
        fail,
        () => {
          if (clock.value !== current || blocked) return;
          updateStatus(
            'offline',
            'Connection lost. Work may still be running; no commands will be replayed.',
          );
          reconnect = setTimeout(() => {
            if (clock.value === current) setAttempt(value => value + 1);
          }, 2000);
        },
      );
    });
    return () => {
      ++clock.value;
      if (reconnect) clearTimeout(reconnect);
      disconnect();
      if (activeStream.current?.generation === current)
        activeStream.current = null;
    };
  }, [selected, foreground, attempt, merge]);
  const mutateConnections = <T,>(operation: () => Promise<T>) => {
    const next = connectionMutations.current.then(operation, operation);
    connectionMutations.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const pair = (link: string, name: string) =>
    mutateConnections(async () => {
      if (loading)
        throw new Error(
          'Wait for secure storage to finish loading, then retry pairing.',
        );
      if (connectionsRef.current.length >= 8)
        throw new Error(
          'Up to eight connections can be saved. Forget an old connection first.',
        );
      const connection = await pairDevice(link, name);
      await saveConnection(connection, connectionsRef.current);
      const next = [...connectionsRef.current, connection];
      connectionsRef.current = next;
      setConnections(next);
      setSelectedId(connection.id);
    });
  const forget = (id: string) =>
    mutateConnections(async () => {
      await forgetConnection(id, connectionsRef.current);
      const next = connectionsRef.current.filter(item => item.id !== id);
      terminalFailures.current.delete(id);
      connectionsRef.current = next;
      setConnections(next);
      setSelectedId(current =>
        current === id ? (next[0]?.id ?? '') : current,
      );
    });
  const sessionKey = (hostId: string, sessionId: string) =>
    keyFor(selectedId, hostId, sessionId);
  const selectConnection = (id: string) => {
    setStatuses(previous => ({
      ...previous,
      [id]: { status: 'connecting', error: '' },
    }));
    setSelectedId(id);
    setAttempt(value => value + 1);
  };
  const changeDraft = (hostId: string, sessionId: string, text: string) => {
    const key = sessionKey(hostId, sessionId);
    const next = { text, version: (draftsRef.current[key]?.version ?? 0) + 1 };
    draftsRef.current[key] = next;
    setDrafts(previous => ({ ...previous, [key]: next }));
  };
  const ready = (hostId: string) =>
    foreground &&
    connectionState.status === 'connected' &&
    view?.computers.some(
      computer => computer.id === hostId && computer.status === 'connected',
    ) === true;
  const runCommand = async (value: MobileCommand, requestKey: string) => {
    if (!selected || !ready(value.hostId) || requests.current.has(requestKey))
      throw new Error(
        'Reconnect and refresh this computer before sending a command.',
      );
    const connection = selected;
    const clock = generation.current.value;
    requests.current.add(requestKey);
    setPending(previous => ({ ...previous, [requestKey]: true }));
    setErrors(previous => ({ ...previous, [requestKey]: '' }));
    try {
      const session = await command(connection, value);
      if (clock === generation.current.value) merge(connection.id, session);
      return session;
    } catch (error) {
      const text =
        error instanceof Error
          ? error.message
          : 'The command could not be confirmed.';
      setErrors(previous => ({ ...previous, [requestKey]: text }));
      if (
        error instanceof GatewayError &&
        terminalCodes.has(error.code) &&
        clock === generation.current.value
      ) {
        const stream = activeStream.current;
        if (
          stream?.connectionId === connection.id &&
          stream.generation === clock
        )
          stream.fail(error);
      }
      throw error;
    } finally {
      requests.current.delete(requestKey);
      setPending(previous => {
        const next = { ...previous };
        delete next[requestKey];
        return next;
      });
    }
  };
  const send = async (session: DesktopSession) => {
    const target = view?.sessions.find(
      item => item.hostId === session.hostId && item.id === session.id,
    );
    if (!selected || !target || ['running', 'stopping'].includes(target.status))
      return;
    const connection = selected;
    const requestGeneration = generation.current.value;
    const key = keyFor(connection.id, session.hostId, session.id);
    const draft = draftsRef.current[key];
    const text = draft?.text.trim();
    if (!text || text.length > 32000) return;
    const prior = sendAttempts.current[key];
    const attempt =
      prior?.text === text
        ? prior
        : { text, messageId: randomUUID(), id: randomUUID() };
    sendAttempts.current[key] = attempt;
    const acknowledge = () => {
      delete sendAttempts.current[key];
      setErrors(previous => ({ ...previous, [key]: '' }));
      if (draftsRef.current[key]?.version === draft.version) {
        const next = { text: '', version: draft.version + 1 };
        draftsRef.current[key] = next;
        setDrafts(previous => ({ ...previous, [key]: next }));
      }
    };
    try {
      await runCommand(
        {
          id: attempt.id,
          method: 'send-message',
          hostId: session.hostId,
          input: { sessionId: session.id, messageId: attempt.messageId, text },
        },
        key,
      );
      acknowledge();
    } catch {
      try {
        const data = await snapshot(connection);
        const found = data.sessions.find(
          item => item.id === session.id && item.hostId === session.hostId,
        );
        if (found && requestGeneration === generation.current.value)
          merge(connection.id, found);
        if (found?.messages.some(message => message.id === attempt.messageId))
          acknowledge();
      } catch {
        return;
      }
    }
  };
  const act = async (
    session: DesktopSession,
    method: 'stop-run' | 'respond-approval' | 'decide-delegation',
    id?: string,
    decision?: 'accept' | 'decline',
  ) => {
    if (
      !session.runId ||
      !ready(session.hostId) ||
      session.status !== 'running'
    )
      return;
    const key = `${sessionKey(session.hostId, session.id)}/${session.runId}/${id ?? 'stop'}`;
    const base = { id: randomUUID(), hostId: session.hostId };
    const input = { sessionId: session.id, runId: session.runId };
    try {
      if (method === 'stop-run')
        await runCommand({ ...base, method, input }, key);
      else if (
        method === 'respond-approval' &&
        id &&
        decision &&
        session.pendingApprovals.some(approval => approval.id === id)
      )
        await runCommand(
          { ...base, method, input: { ...input, requestId: id, decision } },
          key,
        );
      else if (
        method === 'decide-delegation' &&
        id &&
        decision &&
        session.delegations.some(
          delegation =>
            delegation.id === id &&
            delegation.runId === session.runId &&
            delegation.status === 'pending',
        )
      )
        await runCommand(
          { ...base, method, input: { ...input, delegationId: id, decision } },
          key,
        );
    } catch {
      return;
    }
  };
  return {
    connections,
    loading,
    storageError,
    selected,
    selectedId,
    selectConnection,
    view,
    status: connectionState.status,
    error: connectionState.error,
    pair,
    forget,
    ready,
    reconnect: () => {
      terminalFailures.current.delete(selectedId);
      setStatuses(previous => ({
        ...previous,
        [selectedId]: { status: 'connecting', error: '' },
      }));
      setAttempt(value => value + 1);
    },
    draft: (hostId: string, id: string) =>
      drafts[sessionKey(hostId, id)]?.text ?? '',
    changeDraft,
    pending,
    errors,
    sessionKey,
    send,
    act,
  };
}

type Workspace = ReturnType<typeof useWorkspaceState>;
const Context = createContext<Workspace | null>(null);

export function MobileWorkspace({ children }: { children: ReactNode }) {
  const state = useWorkspaceState();
  return <Context value={state}>{children}</Context>;
}

export function useMobileWorkspace() {
  const value = use(Context);
  if (!value) throw new Error('Mobile workspace is unavailable.');
  return value;
}
