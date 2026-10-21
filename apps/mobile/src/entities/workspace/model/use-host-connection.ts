import { useEffect, useRef, useState } from 'react';

import { AppState, Platform } from 'react-native';

import * as SecureStore from 'expo-secure-store';

import { programAgents, type Session } from '@entities/session';

import { type HostCapabilities, HostClient, type Pairing, parsePairing } from '@shared/api/host';

import { EMPTY_SNAPSHOT, type LiveSnapshot, type WorkspaceMode } from './workspace-types';

const SAVED_HOST = 'pocket-sessions.host.v1';
const SCREEN_HANDLED_ERRORS = new Set([
  'decision_resolved',
  'decision_expired',
  'decision_not_found',
]);

/** Owns host lifecycle and projections. Session/group mutations live in command modules. */
export function useHostConnection(mode: WorkspaceMode) {
  const [client] = useState(() => new HostClient());
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(EMPTY_SNAPSHOT);
  const [connected, setConnected] = useState(false);
  const [snapshotReady, setSnapshotReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [hostCapabilities, setHostCapabilities] = useState<HostCapabilities | null>(null);
  const [notice, setNotice] = useState('');
  const pairingRef = useRef<Pairing | null>(null);

  useEffect(() => {
    const unsubscribe = client.subscribe(event => {
      if (event.type === 'connected') {
        setConnected(true);
        setConnecting(false);
        setNotice('');
        client.listSessions();
      } else if (event.type === 'disconnected') {
        setSnapshotReady(false);
        setConnected(false);
        setConnecting(false);
        setHostCapabilities(null);
      } else if (event.type === 'capabilities') {
        setHostCapabilities({
          hostId: event.hostId,
          pushNotifications: event.pushNotifications,
          attention: event.attention,
          attentionInbox: event.attentionInbox,
          decisions: event.decisions,
          jobPages: event.jobPages,
          workspace: event.workspace,
          programs: event.programs,
          providerLimits: event.providerLimits ?? [],
        });
      } else if (event.type === 'error') {
        setConnecting(false);
        if (event.code && SCREEN_HANDLED_ERRORS.has(event.code)) return;
        setNotice(
          event.code === 'revision_conflict'
            ? 'Groups changed on another device. The list was refreshed; try your change again.'
            : event.message,
        );
        if (event.code === 'revision_conflict') client.listSessions();
      } else if (event.type === 'sessions') {
        setSnapshotReady(true);
        const sessions: Session[] = event.sessions.map(session => ({
          ...session,
          agent: programAgents[session.program ?? 'shell'],
          project: session.cwd.split(/[\\/]/).filter(Boolean).at(-1) || session.cwd,
          host: pairingRef.current ? new URL(pairingRef.current.url).hostname : 'Computer',
          status: session.status?.state ?? 'unknown',
          statusSource:
            session.status?.confirmedSource === 'osc7501'
              ? 'program'
              : session.status?.evidence === 'hook'
                ? 'hook'
                : session.status?.source,
          statusUpdatedAt: session.status?.updatedAt,
          preview: session.running ? 'Session runs on your computer' : 'Terminal process ended',
          live: true,
        }));
        setSnapshot({ sessions, groups: event.groups, revision: event.revision });
      } else if (event.type === 'control') {
        setSnapshot(current => {
          const session = current.sessions.find(item => item.id === event.sessionId);
          if (
            !session ||
            (session.controllerId === event.controllerId &&
              session.cols === event.cols &&
              session.rows === event.rows)
          )
            return current;
          return {
            ...current,
            sessions: current.sessions.map(item =>
              item.id === event.sessionId
                ? { ...item, controllerId: event.controllerId, cols: event.cols, rows: event.rows }
                : item,
            ),
          };
        });
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
      .then(saved => {
        if (active && saved && !pairingRef.current) {
          const parsed = parsePairing(saved);
          setPairing(parsed);
          pairingRef.current = parsed;
        }
      })
      .catch(() => {
        if (active) setNotice('Could not read the saved host. Pair it again.');
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active' && pairingRef.current && mode === 'live' && !client.isConnected) {
        setConnecting(true);
        client.connect(pairingRef.current);
      }
    });
    return () => listener.remove();
  }, [client, mode]);

  async function connect(value: Pairing) {
    pairingRef.current = value;
    setPairing(value);
    setSnapshotReady(false);
    setSnapshot(EMPTY_SNAPSHOT);
    setHostCapabilities(null);
    setConnecting(true);
    setNotice('');
    client.connect(value);
    if (Platform.OS !== 'web') {
      try {
        await SecureStore.setItemAsync(SAVED_HOST, JSON.stringify(value));
      } catch {
        setNotice('The key was not saved. Pair the host again after restarting the app.');
      }
    }
  }

  async function forget() {
    client.disconnect();
    pairingRef.current = null;
    setPairing(null);
    setSnapshotReady(false);
    setSnapshot(EMPTY_SNAPSHOT);
    setHostCapabilities(null);
    if (Platform.OS !== 'web') {
      try {
        await SecureStore.deleteItemAsync(SAVED_HOST);
      } catch {
        setNotice('Could not remove the key from storage. Try again.');
      }
    }
  }

  return {
    client,
    snapshot,
    snapshotReady,
    connected,
    connecting,
    pairing,
    hostCapabilities,
    notice,
    setNotice,
    connect,
    forget,
  };
}
