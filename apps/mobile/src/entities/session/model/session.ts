import type {
  AttentionEvent,
  CurrentAttention,
  SessionStatusSource as HostSessionStatusSource,
  SessionProgram,
  SessionReadiness,
  SessionStatusState,
} from '@shared/api/host';

export type SessionStatus = SessionStatusState;
export type SessionStatusSource = HostSessionStatusSource;
export type SessionStateFreshness = {
  observedAt: number;
  stale: boolean;
  lastKnown: SessionStatus | null;
};

export const programLabels: Record<SessionProgram, string> = {
  shell: 'Terminal',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  codex: 'Codex',
};

export const programAgents = {
  shell: 'Terminal',
  claude: 'Claude',
  gemini: 'Gemini',
  codex: 'Codex',
} as const;

/** Presentation metadata derived from a host snapshot, or explicit demo data. */
export type Session = {
  currentAttention?: CurrentAttention;
  readiness?: SessionReadiness;
  attention?: AttentionEvent | null;
  muted?: boolean;
  id: string;
  name: string;
  agent: 'Terminal' | 'Claude' | 'Gemini' | 'Codex';
  project: string;
  host: string;
  status: SessionStatus;
  statusSource?: SessionStatusSource;
  statusUpdatedAt?: number;
  statusFreshness?: SessionStateFreshness;
  preview: string;
  cwd: string;
  groupId?: string | null;
  parentSessionId?: string | null;
  live?: boolean;
  running?: boolean;
  hibernated?: boolean;
  controllerId?: number | null;
  cols?: number;
  rows?: number;
};
