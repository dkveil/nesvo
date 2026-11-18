import { z } from 'zod';
import type { Session } from './sessions';

export const resumableSessionStates = [
  'failed',
  'interrupted',
  'stopped',
] as const satisfies Session['status'][];

export const resumeSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  messageId: z.uuid(),
  revision: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(32000),
});
export type ResumeSessionInput = z.infer<typeof resumeSessionSchema>;

export type SessionResumeBlocker =
  'managed' | 'state' | 'no-thread' | 'finished-worktree' | 'archived';

type ResumableSession = Pick<
  Session,
  | 'status'
  | 'role'
  | 'workflowRunId'
  | 'workflowStepId'
  | 'scheduledJobId'
  | 'providerSessionId'
  | 'providerInitialized'
  | 'pendingClaudeFork'
  | 'worktree'
  | 'archivedAt'
>;

const isResumableState = (status: Session['status']) =>
  (resumableSessionStates as readonly string[]).includes(status);

export const sessionResumeBlocker = (
  session: ResumableSession,
): SessionResumeBlocker | null => {
  if (
    session.role === 'worker' ||
    session.workflowRunId ||
    session.workflowStepId ||
    session.scheduledJobId
  )
    return 'managed';
  if (!isResumableState(session.status)) return 'state';
  if (session.archivedAt) return 'archived';
  if (session.worktree && session.worktree.state !== 'active')
    return 'finished-worktree';
  if (
    !session.providerSessionId ||
    !session.providerInitialized ||
    session.pendingClaudeFork
  )
    return 'no-thread';
  return null;
};

export const sessionResumeBlockerMessages: Record<
  SessionResumeBlocker,
  string
> = {
  managed: 'This session is managed by its parent run.',
  state: 'Only a failed, interrupted or stopped session can be resumed.',
  'no-thread':
    'The provider conversation cannot be resumed. Restart the session to begin a new conversation.',
  'finished-worktree': 'This worktree session is finished.',
  archived: 'Unarchive this session before resuming it.',
};

const ERROR_EXCERPT_LENGTH = 400;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export const resumeContinuationText = (
  session: Pick<Session, 'status' | 'error'>,
): string => {
  const error = oneLine(session.error ?? '')
    .slice(0, ERROR_EXCERPT_LENGTH)
    .replace(/[.\s]+$/, '');
  if (session.status === 'failed')
    return error
      ? `Continue from where you stopped. The last turn failed with: ${error}.`
      : 'Continue from where you stopped. The last turn failed.';
  if (session.status === 'interrupted')
    return 'Continue from where you stopped. The last turn was interrupted before it finished.';
  if (session.status === 'stopped')
    return 'Continue from where you stopped. The last turn was stopped before it finished.';
  return 'Continue from where you stopped.';
};
