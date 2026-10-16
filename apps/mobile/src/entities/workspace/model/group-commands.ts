import type { Dispatch, SetStateAction } from 'react';

import { validGroupName } from '@entities/group';
import type { Session } from '@entities/session';

import type { HostClient, SessionGroup } from '@shared/api/host';

import type { WorkspaceMode } from './workspace-types';

type GroupCommandsOptions = {
  client: HostClient;
  mode: WorkspaceMode;
  connected: boolean;
  groups: SessionGroup[];
  sessions: Session[];
  revision: number;
  setExampleGroups: Dispatch<SetStateAction<SessionGroup[]>>;
  setExamples: Dispatch<SetStateAction<Session[]>>;
};

/** Commands write through to the host; only the explicit demo owns local group data. */
export function groupCommands(options: GroupCommandsOptions) {
  const { client, mode, connected, groups, sessions, revision, setExampleGroups, setExamples } =
    options;

  function createGroup(
    name: string,
    parentId: string | null,
    expectedRevision = revision,
  ): boolean {
    if (!validGroupName(name) || (mode === 'live' && !connected)) return false;
    if (mode === 'live') client.createGroup(name.trim(), parentId, expectedRevision);
    else
      setExampleGroups(items => [
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
      setExampleGroups(items =>
        items.map(item => (item.id === group.id ? { ...group, name: group.name.trim() } : item)),
      );
    return true;
  }

  function deleteGroup(groupId: string, expectedRevision = revision): boolean {
    if (
      (mode === 'live' && !connected) ||
      groups.some(item => item.parentId === groupId) ||
      sessions.some(item => item.groupId === groupId)
    )
      return false;
    if (mode === 'live') client.deleteGroup(groupId, expectedRevision);
    else setExampleGroups(items => items.filter(item => item.id !== groupId));
    return true;
  }

  function moveSession(sessionId: string, groupId: string | null): void {
    if (mode === 'live') {
      if (connected) client.moveSession(sessionId, groupId, revision);
    } else
      setExamples(items =>
        items.map(item => (item.id === sessionId ? { ...item, groupId } : item)),
      );
  }

  return { createGroup, updateGroup, deleteGroup, moveSession };
}
