import type { PendingDecision } from '@shared/api/host';

export const MAX_DECISION_CHOICE_LENGTH = 2000;
export const MAX_DECISION_NOTE_LENGTH = 4000;

const DECISION_REFUSALS: Record<string, string> = {
  decision_resolved:
    'This decision was already answered or canceled elsewhere. Your answer was not recorded.',
  decision_expired:
    'This decision expired before the host recorded an answer. Your answer was not recorded.',
  decision_not_found: 'The host no longer knows this decision. Your answer was not recorded.',
};

export type DecisionSubmissionState = 'sending' | 'unknown';
export type DecisionSubmissions = ReadonlyMap<string, DecisionSubmissionState>;

export const decisionRefusal = (code?: string) => (code ? (DECISION_REFUSALS[code] ?? null) : null);

export const submissionKey = ({ id, revision }: Pick<PendingDecision, 'id' | 'revision'>) =>
  `${id}@${revision}`;

export const canSubmitDecision = (
  submissions: DecisionSubmissions,
  decision: Pick<PendingDecision, 'id' | 'revision' | 'state'>,
) => decision.state === 'pending' && !submissions.has(submissionKey(decision));

export const settleUnknownSubmissions = (submissions: DecisionSubmissions) =>
  new Map([...submissions].filter(([, state]) => state === 'sending'));

export const markSubmissionsUnknown = (
  submissions: DecisionSubmissions,
  keys: Iterable<string>,
) => {
  const next = new Map(submissions);
  for (const key of keys) if (next.has(key)) next.set(key, 'unknown');
  return next;
};

export const normalizeDecisionAnswer = (choice: string, note: string) => {
  const trimmedChoice = choice.trim();
  if (!trimmedChoice || trimmedChoice.length > MAX_DECISION_CHOICE_LENGTH) return null;
  const trimmedNote = note.trim().slice(0, MAX_DECISION_NOTE_LENGTH);
  return { choice: trimmedChoice, note: trimmedNote || undefined };
};

export const mergeDecisionPage = (
  current: PendingDecision[],
  incoming: PendingDecision[],
  replace: boolean,
) => {
  const pending = incoming.filter(decision => decision.state === 'pending');
  if (replace) return pending;
  const incomingIds = new Set(pending.map(decision => decision.id));
  return [...current.filter(decision => !incomingIds.has(decision.id)), ...pending];
};
