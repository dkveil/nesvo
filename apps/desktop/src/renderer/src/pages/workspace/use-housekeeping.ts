import { useState } from 'react';
import type {
  DesktopSession,
  SessionGroup,
  SessionGroupList,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import type { SidebarHousekeeping } from '@/widgets/session-sidebar';
import { desktopApi } from './use-sessions';

type Store = {
  groups: (hostId: string) => SessionGroup[];
  supportsGroups: (hostId: string) => boolean;
  hostReady: (hostId?: string) => boolean;
  merge: (sessions: DesktopSession[]) => void;
  mergeGroups: (hostId: string, list: SessionGroupList) => void;
};

export function useHousekeeping(
  store: Store,
  createInGroup: (hostId: string, group: SessionGroup) => void,
): SidebarHousekeeping {
  const [error, setError] = useState('');
  const attempt = async <T>(
    hostId: string,
    action: string,
    run: () => Promise<T>,
  ): Promise<T | null> => {
    setError('');
    if (!store.hostReady(hostId)) {
      setError(`Could not ${action}. Connect this computer and try again.`);
      return null;
    }
    try {
      return await run();
    } catch (failure) {
      setError(`Could not ${action}. ${errorDetail(failure)}`);
      return null;
    }
  };
  const groupsChange = async (
    hostId: string,
    action: string,
    run: () => Promise<SessionGroupList>,
  ) => {
    const list = await attempt(hostId, action, run);
    if (list) store.mergeGroups(hostId, list);
    return !!list;
  };
  const sessionResult = async (
    session: DesktopSession,
    action: string,
    run: () => Promise<DesktopSession>,
  ) => {
    const updated = await attempt(session.hostId, action, run);
    if (updated) store.merge([updated]);
    return !!updated;
  };
  const sessionChange = async (
    session: DesktopSession,
    action: string,
    run: () => Promise<DesktopSession>,
  ) => {
    await sessionResult(session, action, run);
  };
  return {
    supports: store.supportsGroups,
    groups: store.groups,
    createGroup: async (hostId, parentId, name) => {
      const groupId = crypto.randomUUID();
      const created = await groupsChange(hostId, 'create the group', () =>
        desktopApi(hostId).createSessionGroup({
          groupId,
          parentId,
          name,
          defaults: {},
        }),
      );
      return created ? groupId : null;
    },
    renameGroup: async (hostId, groupId, name) => {
      await groupsChange(hostId, 'rename the group', () =>
        desktopApi(hostId).updateSessionGroup({ groupId, name }),
      );
    },
    updateDefaults: (hostId, groupId, defaults) =>
      groupsChange(hostId, 'save the group defaults', () =>
        desktopApi(hostId).updateSessionGroup({ groupId, defaults }),
      ),
    moveGroup: async (hostId, groupId, parentId, position) => {
      await groupsChange(hostId, 'move the group', () =>
        desktopApi(hostId).moveSessionGroup({
          groupId,
          parentId,
          position: Math.max(0, position),
        }),
      );
    },
    deleteGroup: async (hostId, groupId) => {
      await groupsChange(hostId, 'delete the group', () =>
        desktopApi(hostId).deleteSessionGroup({ groupId }),
      );
    },
    moveSession: (session, groupId, position) =>
      sessionChange(session, 'move the session', () =>
        desktopApi(session.hostId).moveSession({
          sessionId: session.id,
          groupId,
          position: Math.max(0, position),
        }),
      ),
    renameSession: (session, title) =>
      sessionChange(session, 'rename the session', () =>
        desktopApi(session.hostId).renameSession({
          sessionId: session.id,
          title,
        }),
      ),
    setPinned: (session, pinned) =>
      sessionChange(
        session,
        pinned ? 'pin the session' : 'unpin the session',
        () =>
          desktopApi(session.hostId).setSessionPinned({
            sessionId: session.id,
            pinned,
          }),
      ),
    setArchived: (session, archived) =>
      sessionResult(
        session,
        archived ? 'archive the session' : 'restore the session',
        () =>
          desktopApi(session.hostId).setSessionArchived({
            sessionId: session.id,
            archived,
          }),
      ),
    createInGroup,
    error,
    clearError: () => setError(''),
  };
}
