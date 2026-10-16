import type { Session } from '@entities/session';

import type { SessionGroup, SessionProgram } from '@shared/api/host';

export type WorkspaceMode = 'demo' | 'live';
export type WorkspaceSection = 'sessions' | 'hosts' | 'settings' | 'groups';

/** Application navigation is injected; workspace state never depends on a router. */
export type WorkspaceNavigation = {
  openSession: (id: string) => void;
  returnToSessions: () => void;
  navigateTo: (section: WorkspaceSection) => void;
};

export type LiveSnapshot = {
  sessions: Session[];
  groups: SessionGroup[];
  revision: number;
};

export type CreateSessionOptions = {
  name: string;
  cwd: string;
  program: SessionProgram;
  groupId: string | null;
};

export const EMPTY_SNAPSHOT: LiveSnapshot = { sessions: [], groups: [], revision: 0 };
