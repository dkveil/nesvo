import { createHash, randomUUID } from 'node:crypto';
import {
  isWritableSessionMode,
  stageRecordLimit,
  type CreateSessionInput,
  type Provider,
  type Session,
  type SessionMode,
  type SessionPlan,
  type SessionStageRecord,
  type StageActor,
  type StageQuestionRecord,
} from '@nesvo/contracts';

export const PLAN_INSTRUCTION =
  'Nesvo runs this session plan first. Produce a plan only: list the files you would change and the steps, and do not change anything yet. The owner approves, corrects or rejects the plan before you continue.';

export const PLAN_RECEIVED_MESSAGE =
  'Nesvo saved this plan for the owner. End your turn now; the decision arrives as the next message.';

export const QUESTION_RECORDED_MESSAGE =
  'Your question is waiting for an answer. End your turn now without further work; the answer arrives as your next message.';

export const defaultExecutionMode = (provider: Provider): SessionMode =>
  provider === 'Codex' ? 'supervised' : 'accept-edits';

export const startingPlan = (
  input: Pick<CreateSessionInput, 'provider' | 'mode'>,
): SessionPlan => ({
  id: randomUUID(),
  status: 'planning',
  round: 0,
  targetMode: isWritableSessionMode(input.mode)
    ? input.mode
    : defaultExecutionMode(input.provider),
  text: null,
  runId: null,
  readyAt: null,
});

export const planTurnPrompt = (prompt: string) =>
  `${prompt}\n\n${PLAN_INSTRUCTION}`;

export const approvedPlanMessage = (plan: string, resolutions?: string) =>
  `The plan was accepted. Carry it out now.\n\nApproved plan:\n${plan}${resolutions ? `\n\nResolutions:\n${resolutions}` : ''}`;

export const correctedPlanMessage = (correction: string) =>
  `Revise the plan with this correction and return the full plan again. Do not change anything yet.\n\nCorrection:\n${correction}`;

export const questionAnswerMessage = (
  record: StageQuestionRecord,
  option: string | null,
  text: string | null,
) =>
  [
    `Answer to your question: ${record.question.question.slice(0, 300)}`,
    option ? `Chosen option: ${option}` : '',
    text ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');

export const derivedUuid = (seed: string, purpose: string): string => {
  const hex = createHash('sha256').update(`${seed}\n${purpose}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(
    (parseInt(hex[16] ?? '0', 16) & 0x3) |
    0x8
  ).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export const decisionMessageId = (decisionId: string) =>
  derivedUuid(decisionId, 'message');

export const ownerActor = (via: 'desktop' | 'mobile'): StageActor => ({
  kind: 'owner',
  via,
  sessionId: null,
});

export const coordinatorActor = (sessionId: string): StageActor => ({
  kind: 'coordinator',
  via: 'session-control',
  sessionId,
});

export const appendStageRecord = (
  session: Session,
  record: SessionStageRecord,
): void => {
  session.stageRecords = [...session.stageRecords, record].slice(
    -stageRecordLimit,
  );
};

export const hasStageTools = (session: Session): boolean =>
  (session.parentId !== null || session.workflowRunId !== null) &&
  session.role !== 'worker' &&
  !session.workflowStepId;

export const actorLabel = (actor: StageActor) =>
  actor.kind === 'coordinator'
    ? 'The coordinator'
    : actor.via === 'mobile'
      ? 'The owner on the phone'
      : 'The owner';
