import { sessionResumeBlocker } from '@nesvo/contracts';
import { sessionLastActivityAt, type Session } from '@/entities/session';

export type ResumeCandidate = {
  session: Session;
  restartOnly: boolean;
  selectedByDefault: boolean;
};

type ResumeCandidatesParams = {
  sessions: Session[];
  supportsResume: (hostId: string) => boolean;
};

export function resumeCandidates({
  sessions,
  supportsResume,
}: ResumeCandidatesParams): ResumeCandidate[] {
  return sessions
    .filter(session => supportsResume(session.hostId))
    .map(session => ({ session, blocker: sessionResumeBlocker(session) }))
    .filter(({ blocker }) => !blocker || blocker === 'no-thread')
    .map(({ session, blocker }) => ({
      session,
      restartOnly: blocker === 'no-thread',
      selectedByDefault: !blocker && session.status !== 'stopped',
    }))
    .sort((left, right) =>
      sessionLastActivityAt(right.session).localeCompare(
        sessionLastActivityAt(left.session),
      ),
    );
}
