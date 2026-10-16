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

import { HostClient, parsePairing, type Pairing } from '../connection/client';
import { demoSessions } from '../demo';
import type { Session } from '../SessionScreen';

const SAVED_HOST = 'pocket-sessions.host.v1';

function useAppStateValue() {
  const [client] = useState(() => new HostClient());
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [examples, setExamples] = useState<Session[]>(demoSessions);
  const [live, setLive] = useState<Session[]>([]);
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
  const pendingCreate = useRef<{ name: string; existingIds: Set<string> } | null>(null);

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
        setNotice(event.message);
        setConnecting(false);
        pendingCreate.current = null;
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
        setLive(sessions);
        const pending = pendingCreate.current;
        if (pending) {
          const created = sessions.find(
            (session) => session.name === pending.name && !pending.existingIds.has(session.id),
          );
          if (created) {
            pendingCreate.current = null;
            openSession(created.id);
          }
        }
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
    setLive([]);
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
    setLive([]);
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
      pendingCreate.current = { name, existingIds: new Set(live.map((session) => session.id)) };
      client.createSession(name);
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
    setQuery('');
    setFilter('all');
    router.navigate('/');
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
