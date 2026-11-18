import { isSessionActive } from '@nesvo/contracts';
import type { Session } from '@/entities/session';

export const canFinishAfterMerge = (session: Session) =>
  !!session.pullRequest &&
  !!session.worktree &&
  session.worktree.state !== 'removed' &&
  !session.parentId &&
  !session.workflowStepId &&
  !session.scheduledJobId &&
  !isSessionActive(session);

export const mergedCleanupCandidates = (
  sessions: Session[],
  supports: (hostId: string) => boolean,
) =>
  sessions.filter(
    session =>
      !session.archivedAt &&
      supports(session.hostId) &&
      canFinishAfterMerge(session),
  );
