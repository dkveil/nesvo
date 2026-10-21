import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { Text, View } from 'react-native';

import { useWorkspace } from '@entities/workspace';

import {
  type NotificationTarget,
  observePush,
  pushAvailable,
  readRegistration,
  type Registration,
  requestPushToken,
  saveRegistration,
} from '@shared/notifications';
import { Button, common } from '@shared/ui';

const Context = createContext<{
  enabled: boolean;
  busy: boolean;
  status: string;
  toggle: () => void;
}>({ enabled: false, busy: false, status: '', toggle: () => {} });
export function NotificationProvider({ children }: PropsWithChildren) {
  const {
    client,
    connected,
    snapshotReady,
    hostCapabilities,
    pairing,
    connect,
    sessions,
    openSession,
    navigateTo,
    setNotice,
  } = useWorkspace();
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [target, setTarget] = useState<NotificationTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const pending = useRef<{
    id: string;
    registration: Registration;
    enabled: boolean;
    silent?: boolean;
  } | null>(null);
  const hostId = hostCapabilities?.hostId;
  const operation = useRef(0);
  useEffect(() => {
    operation.current += 1;
  }, [connected, hostId]);
  const enabled = registration !== null && registration.hostId === hostId;
  const reconnectAttempted = useRef(false);
  const handledTarget = useRef<NotificationTarget | null>(null);
  const kindsUpgraded = useRef(false);
  useEffect(() => {
    let active = true;
    let stop = () => {};
    void readRegistration()
      .then(value => {
        if (active) setRegistration(value);
      })
      .catch(() => {
        if (active) setStatus('Nie udało się odczytać ustawień powiadomień.');
      });
    void observePush(value => {
      if (active) {
        reconnectAttempted.current = false;
        setTarget(value);
      }
    })
      .then(cleanup => {
        if (active) stop = cleanup;
        else cleanup();
      })
      .catch(() => {
        if (active) setStatus('Powiadomienia niedostępne w tej wersji.');
      });
    return () => {
      active = false;
      stop();
    };
  }, []);
  useEffect(
    () =>
      client.subscribe(event => {
        const request = pending.current;
        if (!request) return;
        if (event.type === 'pushRegistered' && event.requestId === request.id) {
          pending.current = null;
          const value = request.enabled
            ? { ...request.registration, kinds: event.kinds ?? request.registration.kinds }
            : null;
          void saveRegistration(value)
            .then(() => {
              setRegistration(value);
              if (request.silent) return;
              setStatus(
                request.enabled
                  ? 'Powiadomienia włączone dla tego hosta.'
                  : 'Powiadomienia wyłączone.',
              );
            })
            .catch(() =>
              setStatus('Host zmienił ustawienie, ale telefon nie zapisał go. Spróbuj ponownie.'),
            )
            .finally(() => setBusy(false));
        } else if (
          (event.type === 'error' && event.requestId === request.id) ||
          event.type === 'disconnected'
        ) {
          pending.current = null;
          setBusy(false);
          if (!request.silent) setStatus('Nie potwierdzono zmiany na hoście. Spróbuj ponownie.');
        }
      }),
    [client],
  );
  useEffect(() => {
    if (!target || target === handledTarget.current) return;
    if (!connected) {
      if (pairing && !reconnectAttempted.current) {
        reconnectAttempted.current = true;
        void connect(pairing);
      }
      return;
    }
    if (!hostId || !snapshotReady) return;
    handledTarget.current = target;
    if (target.target.hostId !== hostId) {
      setNotice('To powiadomienie pochodzi z innego hosta.');
      return;
    }
    if (target.type === 'inbox') {
      navigateTo('inbox');
      return;
    }
    const { sessionId, sequence } = target.target;
    if (sessions.some(s => s.id === sessionId)) {
      openSession(sessionId);
      client.acknowledgeAttention(sessionId, sequence);
    } else {
      setNotice('Sesja z powiadomienia jest już niedostępna.');
    }
  }, [
    target,
    connected,
    snapshotReady,
    pairing,
    connect,
    hostId,
    sessions,
    openSession,
    navigateTo,
    client,
    setNotice,
  ]);
  const wantsInboxKinds = hostCapabilities?.decisions === true;
  useEffect(() => {
    if (!connected) kindsUpgraded.current = false;
  }, [connected]);
  useEffect(() => {
    if (
      !connected ||
      !enabled ||
      !registration ||
      !wantsInboxKinds ||
      busy ||
      kindsUpgraded.current ||
      (registration.kinds?.length ?? 0) > 0
    )
      return;
    kindsUpgraded.current = true;
    const id = `push-kinds-${Date.now()}`;
    pending.current = { id, registration, enabled: true, silent: true };
    setBusy(true);
    client.registerPush(registration.token, true, id);
  }, [connected, enabled, registration, wantsInboxKinds, busy, client]);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => {
      operation.current += 1;
      pending.current = null;
      setBusy(false);
      setStatus('Upłynął czas oczekiwania. Sprawdź połączenie i spróbuj ponownie.');
    }, 30000);
    return () => clearTimeout(timer);
  }, [busy]);
  const toggle = async () => {
    if (busy || !connected || !hostId) return;
    setBusy(true);
    const generation = ++operation.current;
    try {
      if (registration && registration.hostId !== hostId)
        throw new Error('Najpierw połącz poprzedni host i wyłącz jego powiadomienia.');
      const value =
        enabled && registration ? registration : { hostId, token: await requestPushToken() };
      const id = `push-${Date.now()}`;
      if (generation !== operation.current || !client.isConnected)
        throw new Error('Połączenie zmieniło się podczas konfiguracji. Spróbuj ponownie.');
      pending.current = { id, registration: value, enabled: !enabled };
      client.registerPush(value.token, !enabled, id);
      setStatus('Zapisywanie na hoście…');
    } catch (error) {
      pending.current = null;
      setBusy(false);
      setStatus(error instanceof Error ? error.message : 'Nie udało się włączyć powiadomień.');
    }
  };
  return (
    <Context.Provider value={{ enabled, busy, status, toggle: () => void toggle() }}>
      {children}
    </Context.Provider>
  );
}
export function NotificationSettings() {
  const { enabled, busy, status, toggle } = useContext(Context);
  const { connected, hostCapabilities } = useWorkspace();
  return (
    <View style={{ gap: 12 }}>
      <Text style={common.heading}>Powiadomienia sesji</Text>
      <Text style={common.body}>
        Pytania, zgody, zakończenie pracy i limity. Przez Expo, bez treści terminala. Dotknięcie
        otwiera właściwą sesję.
      </Text>
      {hostCapabilities?.decisions ? (
        <Text style={common.body}>
          This host also notifies you about pending decisions and finished job results. Tapping
          opens the inbox.
        </Text>
      ) : null}
      {!pushAvailable ? (
        <Text style={common.body}>
          Dostępne w natywnej wersji nesvo, poza Expo Go i przeglądarką.
        </Text>
      ) : (
        <Button
          secondary
          disabled={busy || !connected || !hostCapabilities?.pushNotifications}
          label={busy ? 'Zapisywanie…' : enabled ? 'Wyłącz powiadomienia' : 'Włącz powiadomienia'}
          onPress={toggle}
        />
      )}
      {!!status && <Text style={common.body}>{status}</Text>}
    </View>
  );
}
