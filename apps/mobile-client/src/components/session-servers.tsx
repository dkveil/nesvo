import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Text, View } from 'react-native';
import type { DesktopSession, RunningApp } from '@nesvo/contracts';
import { Action, styles } from '@/components/ui';
import type { Connection } from '@/utils/connections';
import { listRunningApps } from '@/utils/gateway-client';

type Props = {
  connection: Connection | undefined;
  session: DesktopSession;
  childrenSessions: readonly DesktopSession[];
  watching: boolean;
};

export function SessionServers({
  connection,
  session,
  childrenSessions,
  watching,
}: Props) {
  const [open, setOpen] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [result, setResult] = useState<RunningApp[] | 'unavailable' | null>(
    null,
  );
  const { hostId, id } = session;

  useFocusEffect(
    useCallback(() => {
      if (!watching || !open || !connection) return;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        const apps = await listRunningApps(
          connection,
          hostId,
          id,
          controller.signal,
        ).catch(() => 'unavailable' as const);
        if (controller.signal.aborted) return;
        setResult(apps);
        timer = setTimeout(poll, 10_000);
      };
      void poll();
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    }, [connection, hostId, id, open, watching]),
  );

  const renderPort = (app: RunningApp) => {
    const owner =
      app.sessionId === id
        ? session
        : childrenSessions.find(child => child.id === app.sessionId);
    const role =
      owner?.role === 'worker'
        ? 'Worker'
        : owner?.parentId
          ? 'Child session'
          : 'Session';
    const address = /^127\.(?!0\.0\.1$)/.test(app.address)
      ? app.address
      : 'localhost';
    return (
      <Text key={app.pid + ':' + app.port} selectable style={styles.muted}>
        {address}:{app.port} · {role}
        {owner ? ' · ' + owner.title : ''}
        {app.match === 'folder' ? ' · Folder match' : ''}
      </Text>
    );
  };
  const apps = Array.isArray(result) ? result : [];
  const other = apps.filter(app => !app.web);
  return (
    <View style={styles.card}>
      <Action
        label={open ? 'Hide servers' : 'Servers'}
        secondary
        onPress={() => {
          setResult(null);
          setShowOther(false);
          setOpen(!open);
        }}
      />
      {open && (
        <>
          {(!watching || result === 'unavailable') && (
            <Text style={styles.muted}>
              Servers are unavailable on this computer.
            </Text>
          )}
          {watching && result === null && (
            <Text style={styles.muted}>Checking for servers…</Text>
          )}
          {watching && Array.isArray(result) && (
            <>
              {apps.length === 0 && (
                <Text style={styles.muted}>No listening ports.</Text>
              )}
              {apps.filter(app => app.web).map(renderPort)}
              {other.length > 0 && (
                <Action
                  secondary
                  label={'Other ports (' + other.length + ')'}
                  onPress={() => setShowOther(!showOther)}
                />
              )}
              {showOther && other.map(renderPort)}
            </>
          )}
        </>
      )}
    </View>
  );
}
