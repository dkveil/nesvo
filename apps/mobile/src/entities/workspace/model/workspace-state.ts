import { useEffect, useState } from 'react';

import { demoGroups } from '@entities/group';
import { demoSessions, type Session } from '@entities/session';

import type { Pairing, SessionGroup } from '@shared/api/host';

import { groupCommands } from './group-commands';
import { useHostConnection } from './use-host-connection';
import { useSessionCommands } from './use-session-commands';
import type { WorkspaceMode, WorkspaceNavigation } from './workspace-types';
import { useWorkspaceViewState } from './workspace-view-state';

/** Composes entity state and commands without owning platform navigation or rendering. */
export function useWorkspaceState(navigation: WorkspaceNavigation) {
  const [mode, setMode] = useState<WorkspaceMode>('demo');
  const [examples, setExamples] = useState<Session[]>(demoSessions);
  const [exampleGroups, setExampleGroups] = useState<SessionGroup[]>(demoGroups);
  const host = useHostConnection(mode);
  const view = useWorkspaceViewState();
  const { setCreateOpen, setSelectedGroup, setSessionGroup } = view;
  const { sessions: live, groups: liveGroups, revision } = host.snapshot;
  const sessions = mode === 'demo' ? examples : live;
  const groups = mode === 'demo' ? exampleGroups : liveGroups;

  const sessionCommands = useSessionCommands({
    client: host.client,
    mode,
    connected: host.connected,
    hostCapabilities: host.hostCapabilities,
    setExamples,
    onCreated: id => {
      setCreateOpen(false);
      navigation.openSession(id);
    },
    onClosed: navigation.returnToSessions,
  });

  useEffect(() => {
    setSelectedGroup(current =>
      current && current !== 'all' && !groups.some(group => group.id === current) ? 'all' : current,
    );
    setSessionGroup(current =>
      current && !groups.some(group => group.id === current) ? null : current,
    );
  }, [groups, setSelectedGroup, setSessionGroup]);

  async function connect(value: Pairing) {
    setMode('live');
    sessionCommands.setCreateError('');
    view.resetView();
    view.setConnectOpen(false);
    navigation.navigateTo('sessions');
    await host.connect(value);
  }

  function resetDemo() {
    host.client.disconnect();
    setMode('demo');
    setExamples(demoSessions);
    setExampleGroups(demoGroups);
    view.resetView();
    sessionCommands.setCreateError('');
    navigation.navigateTo('sessions');
  }

  return {
    client: host.client,
    snapshotReady: host.snapshotReady,
    connected: host.connected,
    connecting: host.connecting,
    pairing: host.pairing,
    hostCapabilities: host.hostCapabilities,
    notice: host.notice,
    setNotice: host.setNotice,
    forget: host.forget,
    mode,
    examples,
    live,
    sessions,
    groups,
    revision,
    ...view,
    ...sessionCommands,
    ...groupCommands({
      client: host.client,
      mode,
      connected: host.connected,
      groups,
      sessions,
      revision,
      setExampleGroups,
      setExamples,
    }),
    ...navigation,
    connect,
    resetDemo,
  };
}
