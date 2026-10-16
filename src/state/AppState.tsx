import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState as NativeAppState, Platform } from 'react-native';

import { HostClient, parsePairing, type Pairing, type SessionGroup } from '../connection/client';
import { demoSessions } from '../demo';
import { demoGroups, validGroupName } from '../groups';
import type { Session } from '../session';

const SAVED_HOST = 'pocket-sessions.host.v1';
type LiveSnapshot = { sessions: Session[]; groups: SessionGroup[]; revision: number };
const EMPTY_SNAPSHOT: LiveSnapshot = { sessions: [], groups: [], revision: 0 };

function useAppStateValue() {
  const [client] = useState(() => new HostClient());
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [examples, setExamples] = useState<Session[]>(demoSessions);
  const [liveSnapshot, setLiveSnapshot] = useState<LiveSnapshot>(EMPTY_SNAPSHOT);
  const { sessions: live, groups: liveGroups, revision } = liveSnapshot;
  const [exampleGroups, setExampleGroups] = useState<SessionGroup[]>(demoGroups);
  // 'all' is distinct from null: null selects sessions outside every group.
  const [selectedGroup, setSelectedGroup] = useState<string | null>('all');
  const [sessionGroup, setSessionGroup] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [sessionName, setSessionName] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [notice, setNotice] = useState('');
  const pairingRef = useRef<Pairing | null>(null);
  const pendingCreate = useRef<{ requestId: string; sessionId?: string } | null>(null);

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'connected') {
        setConnected(true);
        setConnecting(false);
        setNotice('');
        client.listSessions();
      } else if (event.type === 'disconnected') {
        setConnected(false);
        setConnecting(false);
        pendingCreate.current = null;
      } else if (event.type === 'error') {
        setNotice(
          event.code === 'revision_conflict'
            ? 'Grupy zmieniły się na innym urządzeniu. Lista została odświeżona; ponów zmianę.'
            : event.message,
        );
        if (event.code === 'revision_conflict') client.listSessions();
        setConnecting(false);
        if (event.requestId && event.requestId === pendingCreate.current?.requestId)
          pendingCreate.current = null;
      } else if (event.type === 'created') {
        if (pendingCreate.current && event.requestId === pendingCreate.current.requestId) {
          pendingCreate.current = { requestId: event.requestId, sessionId: event.sessionId };
          // Wait for the authoritative snapshot before opening the new route.
          client.listSessions();
        }
      } else if (event.type === 'sessions') {
        const sessions: Session[] = event.sessions.map((session) => ({
          ...session,
          agent: 'Terminal',
          project: session.cwd.split(/[\\/]/).filter(Boolean).at(-1) || session.cwd,
          host: pairingRef.current ? new URL(pairingRef.current.url).hostname : 'Komputer',
          status: session.running ? 'ready' : 'done',
          preview: session.running
            ? 'Sesja działa na Twoim komputerze'
            : 'Proces terminala zakończony',
          live: true,
        }));
        setLiveSnapshot({ sessions, groups: event.groups, revision: event.revision });
        setSelectedGroup((current) =>
          current && current !== 'all' && !event.groups.some((group) => group.id === current)
            ? 'all'
            : current,
        );
        setSessionGroup((current) =>
          current && !event.groups.some((group) => group.id === current) ? null : current,
        );
        const pending = pendingCreate.current;
        if (pending?.sessionId) {
          const created = sessions.find((session) => session.id === pending.sessionId);
          if (created) {
            pendingCreate.current = null;
            openSession(created.id);
          }
        }
      } else if (event.type === 'control') {
        setLiveSnapshot((snapshot) => ({
          ...snapshot,
          sessions: snapshot.sessions.map((item) =>
            item.id === event.sessionId
              ? { ...item, controllerId: event.controllerId, cols: event.cols, rows: event.rows }
              : item,
          ),
        }));
      }
    });
    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, [client]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let active = true;
    SecureStore.getItemAsync(SAVED_HOST)
      .then((saved) => {
        if (active && saved && !pairingRef.current) {
          const parsed = parsePairing(saved);
          setPairing(parsed);
          pairingRef.current = parsed;
        }
      })
      .catch(() => {
        if (active) setNotice('Nie udało się odczytać zapisanego hosta. Sparuj go ponownie.');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const listener = NativeAppState.addEventListener('change', (state) => {
      if (state === 'active' && pairingRef.current && mode === 'live') {
        setConnecting(true);
        client.connect(pairingRef.current);
      }
    });
    return () => listener.remove();
  }, [client, mode]);

  async function connect(value: Pairing) {
    pairingRef.current = value;
    setPairing(value);
    setMode('live');
    setLiveSnapshot(EMPTY_SNAPSHOT);
    setSelectedGroup('all');
    setSessionGroup(null);
    setQuery('');
    setFilter('all');
    setConnectOpen(false);
    setConnecting(true);
    setNotice('');
    router.navigate('/');
    client.connect(value);
    if (Platform.OS !== 'web') {
      try {
        await SecureStore.setItemAsync(SAVED_HOST, JSON.stringify(value));
      } catch {
        setNotice(
          'Klucz nie został zapisany. Po ponownym uruchomieniu aplikacji sparuj host ponownie.',
        );
      }
    }
  }

  async function forget() {
    client.disconnect();
    pairingRef.current = null;
    setPairing(null);
    setLiveSnapshot(EMPTY_SNAPSHOT);
    if (Platform.OS !== 'web') {
      try {
        await SecureStore.deleteItemAsync(SAVED_HOST);
      } catch {
        setNotice('Nie udało się usunąć klucza z magazynu. Spróbuj ponownie.');
      }
    }
  }

  function create() {
    const name = sessionName.trim();
    if (!name) return;
    if (mode === 'live') {
      if (!connected) {
        setNotice('Połącz host przed utworzeniem sesji.');
        return;
      }
      const requestId = client.requestId();
      pendingCreate.current = { requestId };
      client.createSession(name, sessionGroup, requestId);
    } else {
      const example: Session = {
        id: `demo-${Date.now()}`,
        name,
        agent: 'Terminal',
        project: 'workspace',
        host: 'Podgląd',
        cwd: '~/projects/workspace',
        status: 'ready',
        preview: 'Przykładowy terminal — wpisz help',
        groupId: sessionGroup,
      };
      setExamples((current) => [example, ...current]);
      openSession(example.id);
    }
    setCreateOpen(false);
    setSessionName('');
  }

  function closeSession(session: Session) {
    if (session.live) client.closeSession(session.id);
    else setExamples((items) => items.filter((item) => item.id !== session.id));
    returnToSessions();
  }

  function resetDemo() {
    client.disconnect();
    setMode('demo');
    setExamples(demoSessions);
    setExampleGroups(demoGroups);
    setSelectedGroup('all');
    setSessionGroup(null);
    setQuery('');
    setFilter('all');
    router.navigate('/');
  }

  const groups = mode === 'demo' ? exampleGroups : liveGroups;
  function createGroup(
    name: string,
    parentId: string | null,
    expectedRevision = revision,
  ): boolean {
    if (!validGroupName(name) || (mode === 'live' && !connected)) return false;
    if (mode === 'live') client.createGroup(name.trim(), parentId, expectedRevision);
    else
      setExampleGroups((items) => [
        ...items,
        {
          id: `demo-group-${client.requestId()}`,
          name: name.trim(),
          parentId,
          order: items.length,
        },
      ]);
    return true;
  }
  function updateGroup(group: SessionGroup, expectedRevision = revision): boolean {
    if (!validGroupName(group.name) || (mode === 'live' && !connected)) return false;
    if (mode === 'live')
      client.updateGroup({ ...group, name: group.name.trim() }, expectedRevision);
    else
      setExampleGroups((items) =>
        items.map((item) => (item.id === group.id ? { ...group, name: group.name.trim() } : item)),
      );
    return true;
  }
  function deleteGroup(groupId: string, expectedRevision = revision): boolean {
    if (
      (mode === 'live' && !connected) ||
      groups.some((item) => item.parentId === groupId) ||
      (mode === 'demo' ? examples : live).some((item) => item.groupId === groupId)
    )
      return false;
    if (mode === 'live') client.deleteGroup(groupId, expectedRevision);
    else {
      setExampleGroups((items) => items.filter((item) => item.id !== groupId));
      if (selectedGroup === groupId) setSelectedGroup('all');
      if (sessionGroup === groupId) setSessionGroup(null);
    }
    return true;
  }
  function moveSession(sessionId: string, groupId: string | null): void {
    if (mode === 'live') {
      if (connected) client.moveSession(sessionId, groupId, revision);
    } else
      setExamples((items) =>
        items.map((item) => (item.id === sessionId ? { ...item, groupId } : item)),
      );
  }

  return {
    client,
    mode,
    examples,
    live,
    connected,
    connecting,
    pairing,
    connectOpen,
    setConnectOpen,
    createOpen,
    setCreateOpen,
    sessionName,
    setSessionName,
    query,
    setQuery,
    filter,
    setFilter,
    notice,
    setNotice,
    connect,
    forget,
    create,
    closeSession,
    resetDemo,
    sessions: mode === 'demo' ? examples : live,
    groups,
    revision,
    selectedGroup,
    setSelectedGroup,
    sessionGroup,
    setSessionGroup,
    createGroup,
    updateGroup,
    deleteGroup,
    moveSession,
  };
}

const AppContext = createContext<ReturnType<typeof useAppStateValue> | null>(null);

/** This provider belongs to the root layout, so route changes keep the host alive. */
export function AppStateProvider({ children }: PropsWithChildren) {
  const value = useAppStateValue();
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppState() {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppStateProvider is missing from the root layout.');
  return value;
}

export function openSession(id: string) {
  router.push({ pathname: '/session/[id]', params: { id } });
}

export function returnToSessions() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}
