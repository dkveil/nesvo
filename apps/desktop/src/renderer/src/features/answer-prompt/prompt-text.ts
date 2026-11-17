import type { PlanAcceptMode, SessionMode } from '@nesvo/contracts';
import {
  modeLabel,
  type Provider,
  type Session,
  type SessionPrompt,
} from '@/entities/session';

const acceptOrder: PlanAcceptMode[] = ['accept-edits', 'auto'];

export const planAcceptModes = (modes: SessionMode[]) =>
  acceptOrder.filter(mode => modes.includes(mode));

export const planHeading = (prompt: SessionPrompt) =>
  prompt.planRound > 1 ? `Revised plan ${prompt.planRound}` : 'Proposed plan';

export const planOutcome = (prompt: SessionPrompt, provider: Provider) => {
  if (prompt.status === 'accepted')
    return prompt.decision?.mode
      ? `Accepted · continues in ${modeLabel(provider, prompt.decision.mode)}`
      : 'Accepted';
  if (prompt.status === 'revised') return 'Sent back for changes';
  if (prompt.status === 'declined') return 'Declined';
  if (prompt.status === 'interrupted') return 'Not answered';
  return '';
};

export const acceptNote = (provider: Provider, modes: PlanAcceptMode[]) =>
  `Accepting switches this session to ${modes
    .map(mode => modeLabel(provider, mode))
    .join(' or ')} from the next turn; nothing broader.`;

export const noAcceptModeNote =
  'This provider reports no edit mode to continue in. Send feedback or stop the run.';

export const planAcceptBlockedReason = (session: Session) =>
  session.role === 'worker'
    ? 'A worker cannot widen its access. Send feedback to refine the plan.'
    : session.workflowRunId
      ? 'A workflow task keeps its mode. Send feedback to refine the plan.'
      : '';

export const promptsOfRun = (session: Session, runId: string) =>
  session.prompts
    .filter(prompt => prompt.runId === runId)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.planRound - right.planRound,
    );
