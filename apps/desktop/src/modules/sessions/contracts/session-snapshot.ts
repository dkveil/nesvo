import type { Session } from '../../../shared/api/contracts/harness-cli';
import type { AgentState } from '../../../shared/api/contracts/harness-events';

export type ObservedSession = Session & {
  status?: { state: AgentState };
  currentAttention?: { priority: number; reason: string | null };
};

export type SessionGroup = {
  id: string;
  parentId: string | null;
  name: string;
  order: number;
};

export type SessionsSnapshot = {
  sessions: ObservedSession[];
  groups: SessionGroup[];
  revision: number;
};

export type SessionRowState = AgentState | 'exited';

export type SessionRow = {
  id: string;
  name: string;
  cwd: string;
  program: NonNullable<Session['program']>;
  groupName: string | null;
  state: SessionRowState;
  needsAttention: boolean;
  running: boolean;
};
