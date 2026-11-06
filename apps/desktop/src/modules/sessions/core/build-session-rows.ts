import type {
  ObservedSession,
  SessionGroup,
  SessionRow,
  SessionRowState,
  SessionsSnapshot,
} from '../contracts/session-snapshot';

const resolveState = (session: ObservedSession): SessionRowState => {
  if (!session.running) return 'exited';
  return session.status?.state ?? 'unknown';
};

const groupOrder = (groups: SessionGroup[], groupId: string | null) =>
  groups.find(group => group.id === groupId)?.order ?? -1;

export const buildSessionRows = ({ sessions, groups }: SessionsSnapshot): SessionRow[] =>
  [...sessions]
    .sort(
      (left, right) =>
        groupOrder(groups, left.groupId) - groupOrder(groups, right.groupId) ||
        left.createdAt.localeCompare(right.createdAt),
    )
    .map(session => ({
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      program: session.program ?? 'shell',
      groupName: groups.find(group => group.id === session.groupId)?.name ?? null,
      state: resolveState(session),
      needsAttention: (session.currentAttention?.priority ?? 0) > 0,
      running: session.running,
    }));
