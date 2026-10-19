export type Pairing = { version: 1; url: string; key: string };

export type SessionProgram = 'shell' | 'claude' | 'gemini' | 'codex';
export type SessionStatusState =
  'working' | 'idle' | 'done' | 'blocked' | 'question' | 'failed' | 'unknown';
export type SessionStatusSource = 'activity' | 'screen' | 'hook' | 'program' | 'process';
export type SessionStatus = {
  state: SessionStatusState;
  source: SessionStatusSource;
  evidence?: 'hook';
  confirmedSource?: 'osc7501';
  updatedAt: number;
};
export type SessionReadiness = {
  phase: 'notApplicable' | 'starting' | 'waiting' | 'ready' | 'timedOut' | 'exited';
  initialized: boolean;
  reason: string;
};
export type SessionLifecycle = {
  process: { running: boolean; pid: number | null };
  agent: {
    current: SessionStatus | null;
    lastKnown: SessionStatus | null;
    blockReason: 'permission' | 'question' | 'auth' | 'quota' | 'setup' | 'unknown' | null;
    freshness: 'observed' | 'unknown' | 'processExited';
  };
  turn: {
    id: string;
    generation: number;
    phase: 'accepted' | 'started' | 'waiting' | 'settled' | 'interrupted' | 'failed';
    elapsedSeconds: number;
    observedAt: number;
    outcome: string | null;
  } | null;
};
export type AttentionEvent = {
  subject?: 'response';
  turnId?: string;
  source?: SessionStatusSource;
  sequence: number;
  kind: 'question' | 'permission' | 'done' | 'failed' | 'limit';
  at: number;
  unread: boolean;
};
export type CurrentAttention = {
  priority: number;
  reason:
    | 'permission'
    | 'question'
    | 'auth'
    | 'quota'
    | 'setup'
    | 'unknown'
    | 'startup'
    | 'failure'
    | 'child'
    | null;
  status: SessionStatus | null;
  blockedChildren: number;
};
export type AttentionSummary = {
  sessions: number;
  needsYou: number;
  highest: CurrentAttention | null;
};
export type HostCapabilities = {
  hostId?: string;
  pushNotifications?: boolean;
  attention?: boolean;
  workspace: string;
  programs: { id: SessionProgram; label: string; available: boolean }[];
  providerLimits?: ProviderLimit[];
};
export type ProviderLimit = {
  id: Exclude<SessionProgram, 'shell'>;
  status: 'checking' | 'ready' | 'unavailable';
  windows: { usedPercent: number; durationMins: number; resetsAt: number | null }[];
};
export type SessionLaunchOptions = { cwd?: string; program?: SessionProgram };

export type SessionGroup = {
  id: string;
  parentId: string | null;
  name: string;
  order: number;
  attentionSummary?: AttentionSummary;
};
export type SessionControl = {
  sessionId: string;
  controllerId: number | null;
  leaseId?: string;
  cols: number;
  rows: number;
};

export type TerminalSession = {
  role?: 'worker' | 'coordinator';
  parentSessionId?: string | null;
  currentAttention?: CurrentAttention;
  lifecycle?: SessionLifecycle;
  readiness?: SessionReadiness;
  attention?: AttentionEvent | null;
  muted?: boolean;
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  uptimeSeconds?: number;
  cols: number;
  rows: number;
  running: boolean;
  groupId: string | null;
  controllerId: number | null;
  program?: SessionProgram;
  status?: SessionStatus;
};

export type HostEvent =
  | { type: 'pushRegistered'; enabled: boolean; requestId?: string }
  | { type: 'connected'; clientId: number; protocolVersion: 2 }
  | { type: 'disconnected'; reason: string }
  | ({ type: 'capabilities'; requestId?: string } & HostCapabilities)
  | { type: 'sessions'; sessions: TerminalSession[]; groups: SessionGroup[]; revision: number }
  | { type: 'created'; sessionId: string; requestId?: string }
  | { type: 'groupCreated'; groupId: string; revision: number; requestId?: string }
  | { type: 'updated'; revision: number; requestId?: string }
  | { type: 'subscribed'; sessionId: string; cols: number; rows: number }
  | { type: 'unsubscribed'; sessionId: string }
  | ({ type: 'control' } & SessionControl)
  | { type: 'attached'; sessionId: string }
  | { type: 'output'; sessionId: string; data: string; replay?: boolean; allowResponses?: boolean }
  | { type: 'error'; message: string; requestId?: string; code?: string; revision?: number };

export type ClientCommand =
  | { type: 'registerPush'; token: string; enabled: boolean; requestId: string }
  | { type: 'acknowledgeAttention'; sessionId: string; sequence: number }
  | { type: 'muteSession'; sessionId: string; muted: boolean }
  | { type: 'auth'; clientNonce: string }
  | { type: 'list' }
  | { type: 'getCapabilities'; requestId?: string }
  | ({
      type: 'create';
      name: string;
      groupId: string | null;
      requestId: string;
    } & SessionLaunchOptions)
  | {
      type: 'createGroup';
      name: string;
      parentId: string | null;
      expectedRevision: number;
      requestId?: string;
    }
  | {
      type: 'updateGroup';
      groupId: string;
      name: string;
      parentId: string | null;
      order: number;
      expectedRevision: number;
      requestId?: string;
    }
  | { type: 'deleteGroup'; groupId: string; expectedRevision: number; requestId?: string }
  | {
      type: 'moveSession';
      sessionId: string;
      groupId: string | null;
      expectedRevision: number;
      requestId?: string;
    }
  | { type: 'subscribe' | 'unsubscribe'; sessionId: string }
  | { type: 'acquireControl'; sessionId: string; cols: number; rows: number; takeOver: boolean }
  | { type: 'releaseControl'; sessionId: string; leaseId: string }
  | { type: 'attach'; sessionId: string; cols: number; rows: number }
  | { type: 'input'; sessionId: string; data: string; leaseId: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number; leaseId: string }
  | { type: 'close'; sessionId: string };

export type ServerMessage =
  | Exclude<HostEvent, { type: 'disconnected' | 'connected' }>
  | { type: 'connected'; clientNonce: string; clientId: number; protocolVersion: 2 };
