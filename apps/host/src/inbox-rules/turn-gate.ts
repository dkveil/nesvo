import type { Approval, Session, SessionMode } from '@nesvo/contracts';

export type ProviderToolSubject = {
  tool: string;
  input: Record<string, unknown>;
};

export type TurnGate = {
  askRules: string[];
  holds: (subject: ProviderToolSubject) => boolean;
  withoutHostPrompts: { refusal: string | null; warning: string | null };
};

export type PreparedTurnRules = {
  gate: TurnGate;
  refusal: string | null;
  warnings: string[];
};

export type SessionInboxHooks = {
  prepareTurn: (
    session: Session,
    turn: { mode: SessionMode },
    signal: AbortSignal,
  ) => Promise<PreparedTurnRules>;
  approvalRequested: (
    session: Session,
    approval: Approval,
    subject: ProviderToolSubject | null,
  ) => string | null;
  holdsAfterRun: (session: Session) => boolean;
  heldReason: (sessionId: string) => string | null;
};

export const commandOf = (subject: ProviderToolSubject): string | null =>
  subject.tool === 'Bash' && typeof subject.input.command === 'string'
    ? subject.input.command
    : null;
