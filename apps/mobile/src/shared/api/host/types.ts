import type {
  AttentionItem,
  AttentionReceipt,
  HarnessCliEnvelope,
  JobDefinition,
  RepositoryContext,
  SessionHibernation,
  JobOccurrence as WireJobOccurrence,
  JobRetryDecision as WireJobRetryDecision,
  JobRetryPolicy as WireJobRetryPolicy,
  Session as WireSession,
} from '../contracts/harness-cli';
import type { AgentState, Program } from '../contracts/harness-events';

type CliReply = Extract<HarnessCliEnvelope, { ok: true }>['data'];
type CliReplyOf<TType extends string> = Extract<CliReply, { type: TType }>;
type WireDecision = CliReplyOf<'decisions'>['decisions'][number];

export type { RepositoryContext, SessionHibernation };

export type Pairing = { version: 1; url: string; key: string };

export type SessionProgram = Program;
export type SessionStatusState = AgentState;
export type SessionStatusSource = 'activity' | 'screen' | 'hook' | 'program' | 'process';
export type SessionFreshnessSource = 'hook' | 'process' | 'journal' | 'unknown';
export type SessionFreshness = {
  source: SessionFreshnessSource;
  observedAt: number;
  ageMs: number;
  stale: boolean;
  boundMs: number | null;
  lastKnown: { state: SessionStatusState; observedAt: number } | null;
};
export type SessionStatus = {
  state: SessionStatusState;
  source: SessionStatusSource;
  evidence?: 'hook';
  confirmedSource?: 'osc7501';
  updatedAt: number;
  freshness?: SessionFreshness;
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
  attentionInbox?: boolean;
  decisions?: boolean;
  jobPages?: boolean;
  pushDevices?: boolean;
  sessionFreshness?: boolean;
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

export type InboxFeatures = {
  attentionInbox: boolean;
  decisions: boolean;
  jobPages: boolean;
  pushDevices: boolean;
};
export type InboxItemKind = AttentionItem['kind'];
export type InboxItemProgram = NonNullable<AttentionItem['program']>;
export type InboxItem = Pick<
  AttentionItem,
  | 'id'
  | 'kind'
  | 'revision'
  | 'reason'
  | 'at'
  | 'title'
  | 'summary'
  | 'sessionId'
  | 'decisionId'
  | 'runId'
  | 'taskId'
  | 'attemptId'
  | 'jobId'
  | 'occurrenceId'
  | 'expiresAt'
  | 'program'
> & { priority: 1 | 2 | 3 };
export type JobRead =
  | { action: 'list'; page: number }
  | { action: 'get'; jobId: string }
  | { action: 'history'; jobId: string; page: number };
export type InboxReceipt = AttentionReceipt;
export type InboxMark = Pick<InboxReceipt, 'id' | 'revision'>;
export type DecisionState = WireDecision['state'];
export type PendingDecision = Pick<
  WireDecision,
  | 'id'
  | 'runId'
  | 'taskId'
  | 'attemptId'
  | 'question'
  | 'revision'
  | 'state'
  | 'audience'
  | 'createdAt'
  | 'expiresAt'
  | 'answer'
  | 'inboxId'
  | 'run'
>;
export type PushKind = 'decisionPending' | 'resultReady';
export type PushDevice = { device: string; kinds: PushKind[] };

export type JobSchedule = JobDefinition['schedule'];
export type JobCalendarState = NonNullable<JobDefinition['calendarState']>;
export type JobCalendarError = NonNullable<JobDefinition['calendarError']>;
export type JobSummary = Pick<
  JobDefinition,
  'id' | 'title' | 'revision' | 'enabled' | 'nextDueAt' | 'createdAt'
> & {
  schedule: JobSchedule | null;
  calendarState: JobCalendarState | null;
  calendarError: JobCalendarError | null;
};
export type JobRetryPolicy = Omit<WireJobRetryPolicy, 'on'> & { on: string };
export type Job = JobSummary & {
  spec: {
    instruction: string;
    profile: { program?: SessionProgram; workspace: string };
    retry?: JobRetryPolicy;
    misfire?: string;
    overlap?: string;
    executionTimeoutMs?: number;
  };
};
export type JobOccurrenceState = WireJobOccurrence['state'];
export type JobRetryClass = NonNullable<WireJobRetryDecision['class']>;
export type JobRetryDecision = Pick<
  WireJobRetryDecision,
  'class' | 'decidedAt' | 'notBefore' | 'nextOrdinal'
>;
export type JobOccurrence = Pick<
  WireJobOccurrence,
  | 'id'
  | 'jobId'
  | 'jobRevision'
  | 'dueAt'
  | 'createdAt'
  | 'state'
  | 'reason'
  | 'runId'
  | 'startedAt'
  | 'finishedAt'
> & {
  trigger: string;
  jobAttemptId: Exclude<WireJobOccurrence['jobAttemptId'], undefined>;
  jobAttemptOrdinal: Exclude<WireJobOccurrence['jobAttemptOrdinal'], undefined>;
  retry: JobRetryDecision | null;
};

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

export type TerminalSession = Pick<
  WireSession,
  | 'id'
  | 'name'
  | 'cwd'
  | 'createdAt'
  | 'uptimeSeconds'
  | 'cols'
  | 'rows'
  | 'running'
  | 'groupId'
  | 'controllerId'
  | 'program'
  | 'repositoryContext'
  | 'hibernation'
> & {
  role?: 'worker' | 'coordinator';
  parentSessionId?: string | null;
  currentAttention?: CurrentAttention;
  lifecycle?: SessionLifecycle;
  readiness?: SessionReadiness;
  attention?: AttentionEvent | null;
  muted?: boolean;
  status?: SessionStatus;
};

export type HostEvent =
  | { type: 'pushRegistered'; enabled: boolean; kinds?: string[]; requestId?: string }
  | {
      type: 'attentionInbox';
      items: InboxItem[];
      page: number;
      limit: number;
      nextPage: number | null;
      total: number;
      skipped?: number;
      requestId?: string;
    }
  | { type: 'inboxAcknowledged'; acknowledged: InboxReceipt[]; requestId?: string }
  | {
      type: 'decisions';
      decisions: PendingDecision[];
      page: number;
      nextPage: number | null;
      total: number;
      skipped?: number;
      requestId?: string;
    }
  | {
      type: 'decided';
      decision: Pick<WireDecision, 'id' | 'revision'> & { state: string };
      inboxId: string;
      requestId?: string;
    }
  | { type: 'attentionInboxChanged'; reason: string; itemId?: string }
  | {
      type: 'jobPage';
      jobs: JobSummary[];
      page: number;
      nextPage: number | null;
      requestId?: string;
    }
  | { type: 'jobDetail'; job: Job; requestId?: string }
  | {
      type: 'jobHistory';
      occurrences: JobOccurrence[];
      page: number;
      nextPage: number | null;
      skipped?: number;
      requestId?: string;
    }
  | { type: 'pushDevices'; devices: PushDevice[]; requestId?: string }
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
  | {
      type: 'registerPush';
      token: string;
      enabled: boolean;
      requestId: string;
      kinds?: PushKind[];
    }
  | { type: 'attentionInbox'; page: number; limit?: number; requestId: string }
  | { type: 'acknowledgeInbox'; items: InboxMark[]; requestId: string }
  | { type: 'decisions'; page: number; requestId: string }
  | { type: 'decide'; decisionId: string; choice: string; note?: string; requestId: string }
  | { type: 'workflow'; request: { action: 'jobs'; request: JobRead }; requestId: string }
  | { type: 'pushDevices'; requestId: string }
  | { type: 'acknowledgeAttention'; sessionId: string; sequence: number }
  | { type: 'muteSession'; sessionId: string; muted: boolean }
  | { type: 'auth'; clientNonce: string }
  | { type: 'list' }
  | { type: 'getCapabilities'; sessionFreshness?: boolean; requestId?: string }
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
