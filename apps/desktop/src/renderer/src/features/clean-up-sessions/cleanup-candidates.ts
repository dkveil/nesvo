import { isSessionActive, isSubsessionOf } from '@nesvo/contracts';
import { sessionLastActivityAt, type Session } from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';

export const cleanupPresets = [7, 14, 30] as const;

export type CleanupPreset = (typeof cleanupPresets)[number];

export const DEFAULT_CLEANUP_DAYS: CleanupPreset = 14;

const DAY_MS = 86_400_000;

export type CleanupCandidate = {
  session: Session;
  lastActivityAt: string;
};

type CleanupCandidatesInput = {
  sessions: Session[];
  now: number;
  days: number;
  isEligibleHost: (hostId: string) => boolean;
  busyKeys: ReadonlySet<string>;
};

const isTopLevel = (session: Session) =>
  !session.parentId && !session.workflowStepId && !session.scheduledJobId;

const hasActiveSubsession = (root: Session, sessions: Session[]) =>
  sessions.some(
    candidate =>
      candidate.hostId === root.hostId &&
      isSubsessionOf(root, candidate) &&
      isSessionActive(candidate),
  );

export function cleanupCandidates({
  sessions,
  now,
  days,
  isEligibleHost,
  busyKeys,
}: CleanupCandidatesInput): CleanupCandidate[] {
  const cutoff = now - days * DAY_MS;
  return sessions
    .filter(
      session =>
        isTopLevel(session) &&
        !session.archivedAt &&
        !session.pinned &&
        !isSessionActive(session) &&
        !busyKeys.has(entityKey(session)) &&
        isEligibleHost(session.hostId) &&
        !hasActiveSubsession(session, sessions),
    )
    .map(session => ({
      session,
      lastActivityAt: sessionLastActivityAt(session),
    }))
    .filter(candidate => Date.parse(candidate.lastActivityAt) <= cutoff)
    .sort(
      (left, right) =>
        left.lastActivityAt.localeCompare(right.lastActivityAt) ||
        left.session.id.localeCompare(right.session.id),
    );
}
