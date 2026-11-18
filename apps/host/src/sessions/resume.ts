import {
  sessionResumeBlocker,
  sessionResumeBlockerMessages,
  type ResumeSessionInput,
  type Session,
} from '@nesvo/contracts';
import { SessionError } from './session-error';
import { savedSkillInput } from '../skills/service';
import type { SessionService } from './service';

type ResumeSessions = Pick<SessionService, 'snapshot' | 'send'>;

export const resumeSession = (
  sessions: ResumeSessions,
  input: ResumeSessionInput,
): Session => {
  const session = sessions.snapshot(input.sessionId);
  if (!session)
    throw new SessionError('not-found', 'Session not found. Refresh the list.');
  const skill = input.promptSkill
    ? savedSkillInput(input.promptSkill)
    : undefined;
  const message = {
    sessionId: input.sessionId,
    messageId: input.messageId,
    text: input.text,
    ...(skill ? { skillId: skill.skillId, skillHash: skill.skillHash } : {}),
  };
  if (session.messages.some(item => item.id === input.messageId))
    return sessions.send(message, { savedSkill: skill?.savedSkill });
  const blocker = sessionResumeBlocker(session);
  if (blocker)
    throw new SessionError(
      session.status === 'running' || session.status === 'stopping'
        ? 'busy'
        : 'invalid-request',
      sessionResumeBlockerMessages[blocker],
    );
  if (session.revision !== input.revision)
    throw new SessionError(
      'invalid-request',
      'The session changed. Review the continuation message and resume again.',
    );
  return sessions.send(message, { savedSkill: skill?.savedSkill });
};
