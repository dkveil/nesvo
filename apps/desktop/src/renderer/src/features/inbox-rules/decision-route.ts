import type { DecisionRoute, SessionGroup } from '@nesvo/contracts';
import type { Session } from '@/entities/session';

export const resolveDecisionRoute = (
  session: Pick<Session, 'decisionRoute' | 'groupId' | 'parentId'>,
  groups: readonly Pick<SessionGroup, 'id' | 'defaults'>[],
  fallback: DecisionRoute,
): DecisionRoute => {
  if (!session.parentId) return 'inbox';
  const group = session.groupId
    ? groups.find(candidate => candidate.id === session.groupId)
    : undefined;
  return session.decisionRoute ?? group?.defaults.decisionRoute ?? fallback;
};
