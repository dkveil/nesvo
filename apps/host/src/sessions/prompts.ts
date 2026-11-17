import type {
  PromptAnswer,
  Session,
  SessionMode,
  SessionPrompt,
} from '@nesvo/contracts';
import type { ClaudePrompt } from '../providers/claude';

export const PROMPT_LIMIT = 50;
export const ACCEPTED_PLAN_MESSAGE = 'Proceed with the accepted plan.';
export const WAITING_FOR_ANSWER = 'Waiting for your answer…';

const modeRank = {
  'read-only': 0,
  supervised: 1,
  'accept-edits': 1,
  auto: 2,
} as const satisfies Record<SessionMode, number>;

export function widensAccess(from: SessionMode, to: SessionMode): boolean {
  return modeRank[to] > modeRank[from];
}

export function pendingPrompts(session: Session): SessionPrompt[] {
  return session.prompts.filter(
    prompt => prompt.status === 'pending' && prompt.runId === session.runId,
  );
}

export function recordPrompt(session: Session, prompt: ClaudePrompt): void {
  if (
    session.prompts.some(
      item => item.id === prompt.id && item.runId === session.runId,
    )
  )
    throw new Error('Duplicate provider prompt');
  session.prompts.push({
    ...prompt,
    runId: session.runId!,
    status: 'pending',
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    answers: null,
    decision: null,
  });
  while (session.prompts.length > PROMPT_LIMIT) {
    const index = session.prompts.findIndex(item => item.status !== 'pending');
    if (index === -1) throw new Error('Too many pending provider prompts');
    session.prompts.splice(index, 1);
  }
}

export function interruptPrompts(
  session: Session,
  at = new Date().toISOString(),
  id?: string,
): boolean {
  let changed = false;
  for (const prompt of session.prompts) {
    if (
      prompt.status !== 'pending' ||
      (id !== undefined && (prompt.id !== id || prompt.runId !== session.runId))
    )
      continue;
    prompt.status = 'interrupted';
    prompt.resolvedAt = at;
    changed = true;
  }
  return changed;
}

export function unansweredQuestion(
  prompt: SessionPrompt,
  answer: Extract<PromptAnswer, { kind: 'question' }>,
): boolean {
  const questions = new Set(prompt.questions.map(item => item.question));
  return (
    Object.keys(answer.answers).some(question => !questions.has(question)) ||
    prompt.questions.some(item => !answer.answers[item.question]?.trim())
  );
}
