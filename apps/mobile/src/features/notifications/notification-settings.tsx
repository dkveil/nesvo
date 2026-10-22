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

import { type PushKind, pushKindsFor } from '@shared/api/host';
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

import { PushDeviceList } from './push-device-list';

const PUSH_KIND_LABELS: Record<PushKind, string> = {
  decisionPending: 'pending decisions',
  resultReady: 'finished job results',
};

const Context = createContext<{
  enabled: boolean;
  busy: boolean;
  status: string;
  token: string | null;
  toggle: () => void;
}>({ enabled: false, busy: false, status: '', token: null, toggle: () => {} });
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
        if (active) setStatus('Could not read notification settings.');
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
        if (active) setStatus('Notifications are unavailable in this build.');
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
                request.enabled ? 'Notifications are on for this host.' : 'Notifications are off.',
              );
            })
            .catch(() =>
              setStatus('The host changed the setting, but the phone did not save it. Try again.'),
            )
            .finally(() => setBusy(false));
        } else if (
          (event.type === 'error' && event.requestId === request.id) ||
          event.type === 'disconnected'
        ) {
          pending.current = null;
          setBusy(false);
          if (!request.silent) setStatus('The host did not confirm the change. Try again.');
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
      setNotice('This notification comes from another host.');
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
      setNotice('The session from this notification is no longer available.');
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
  const missingKinds = pushKindsFor(hostCapabilities ?? {}).filter(
    kind => !registration?.kinds?.includes(kind),
  ).length;
  useEffect(() => {
    if (!connected) kindsUpgraded.current = false;
  }, [connected]);
  useEffect(() => {
    if (
      !connected ||
      !enabled ||
      !registration ||
      missingKinds === 0 ||
      busy ||
      kindsUpgraded.current
    )
      return;
    kindsUpgraded.current = true;
    const id = `push-kinds-${Date.now()}`;
    pending.current = { id, registration, enabled: true, silent: true };
    setBusy(true);
    client.registerPush(registration.token, true, id);
  }, [connected, enabled, registration, missingKinds, busy, client]);
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => {
      const silent = pending.current?.silent === true;
      operation.current += 1;
      pending.current = null;
      setBusy(false);
      if (!silent) setStatus('Timed out. Check the connection and try again.');
    }, 30000);
    return () => clearTimeout(timer);
  }, [busy]);
  const toggle = async () => {
    if (busy || !connected || !hostId) return;
    setBusy(true);
    const generation = ++operation.current;
    try {
      if (registration && registration.hostId !== hostId)
        throw new Error('Connect the previous host first and turn off its notifications.');
      const value =
        enabled && registration ? registration : { hostId, token: await requestPushToken() };
      const id = `push-${Date.now()}`;
      if (generation !== operation.current || !client.isConnected)
        throw new Error('The connection changed during setup. Try again.');
      pending.current = { id, registration: value, enabled: !enabled };
      client.registerPush(value.token, !enabled, id);
      setStatus('Saving on the host…');
    } catch (error) {
      pending.current = null;
      setBusy(false);
      setStatus(error instanceof Error ? error.message : 'Could not turn on notifications.');
    }
  };
  return (
    <Context.Provider
      value={{
        enabled,
        busy,
        status,
        token: enabled && registration ? registration.token : null,
        toggle: () => void toggle(),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function NotificationSettings() {
  const { enabled, busy, status, token, toggle } = useContext(Context);
  const { connected, hostCapabilities } = useWorkspace();
  const inboxKinds = pushKindsFor(hostCapabilities ?? {});
  return (
    <View style={{ gap: 12 }}>
      <Text style={common.heading}>Session notifications</Text>
      <Text style={common.body}>
        Questions, permissions, finished work and limits. Sent through Expo without terminal
        content. Tapping opens the right session.
      </Text>
      {inboxKinds.length > 0 ? (
        <Text style={common.body}>
          This host also notifies you about{' '}
          {inboxKinds.map(kind => PUSH_KIND_LABELS[kind]).join(' and ')}. Tapping opens the inbox.
        </Text>
      ) : null}
      {!pushAvailable ? (
        <Text style={common.body}>
          Available in the native nesvo build, not in Expo Go or the browser.
        </Text>
      ) : (
        <Button
          secondary
          disabled={busy || !connected || !hostCapabilities?.pushNotifications}
          label={busy ? 'Saving…' : enabled ? 'Turn off notifications' : 'Turn on notifications'}
          onPress={toggle}
        />
      )}
      {!!status && <Text style={common.body}>{status}</Text>}
      <PushDeviceList token={token} />
    </View>
  );
}
