import type {
  AttentionItem,
  AttentionReceipt,
  HarnessCliEnvelope,
  JobDefinition,
  JobOccurrence,
  Session,
  SessionHibernation,
} from '../../apps/mobile/src/shared/api/contracts/harness-cli';

type CliReply = Extract<HarnessCliEnvelope, { ok: true }>['data'];
type CliReplyOf<TType extends string> = Extract<CliReply, { type: TType }>;
type WireDecision = CliReplyOf<'decisions'>['decisions'][number];

export const WIRE_SESSION_ID = 'e'.repeat(32);

export const inboxSessionItem = {
  id: `session:${WIRE_SESSION_ID}`,
  kind: 'session',
  revision: 3,
  priority: 3,
  reason: 'question',
  at: 1_792_783_619_000,
  title: 'Review',
  sessionId: WIRE_SESSION_ID,
  program: 'claude',
} as const satisfies AttentionItem;

export const inboxDecisionItem = {
  id: 'decision:run-1:question-1',
  kind: 'decision',
  revision: 1,
  priority: 3,
  reason: 'decision',
  at: 1_792_783_600_000,
  title: 'Release run',
  summary: 'Which branch should the worker use?',
  runId: 'run-1',
  decisionId: 'question-1',
  attemptId: 'attempt-1',
  audience: 'owner',
  expiresAt: 1_792_783_919_000,
} as const satisfies AttentionItem;

export const inboxRunItem = {
  id: 'run:run-2:attempt-2',
  kind: 'run',
  revision: 2,
  priority: 2,
  reason: 'validation',
  at: 1_792_783_000_000,
  title: 'Nightly',
  runId: 'run-2',
  taskId: 'task-1',
  attemptId: 'attempt-2',
} as const satisfies AttentionItem;

export const inboxResultItem = {
  id: 'result:occurrence-1',
  kind: 'result',
  revision: 2,
  priority: 1,
  reason: 'succeeded',
  at: 1_792_782_000_000,
  title: '',
  jobId: 'job-1',
  occurrenceId: 'occurrence-1',
  runId: null,
} as const satisfies AttentionItem;

export const inboxPage = {
  type: 'attentionInbox',
  items: [inboxSessionItem, inboxDecisionItem, inboxRunItem, inboxResultItem],
  page: 0,
  limit: 16,
  nextPage: null,
  total: 4,
} as const satisfies CliReplyOf<'attentionInbox'>;

export const inboxReceipt = {
  id: inboxDecisionItem.id,
  revision: 1,
  acknowledgedAt: 1_792_783_700_000,
} as const satisfies AttentionReceipt;

export const inboxReceipts = {
  type: 'inboxAcknowledged',
  acknowledged: [inboxReceipt],
} as const satisfies CliReplyOf<'inboxAcknowledged'>;

export const pendingDecision = {
  id: 'question-1',
  runId: 'run-1',
  taskId: 'task-1',
  attemptId: 'attempt-1',
  question: 'Which branch should the worker use?',
  revision: 1,
  state: 'pending',
  audience: 'owner',
  askedBy: { kind: 'worker' },
  createdAt: 1_792_783_600_000,
  expiresAt: 1_792_783_919_000,
  answer: null,
  reason: null,
  resolvedAt: null,
  resolvedBy: null,
  inboxId: 'decision:run-1:question-1',
  run: { id: 'run-1', title: 'Release run', state: 'running' },
} as const satisfies WireDecision;

export const decisionsPage = {
  type: 'decisions',
  decisions: [pendingDecision],
  page: 0,
  nextPage: 1,
  total: 9,
} as const satisfies CliReplyOf<'decisions'>;

export const decidedReply = {
  type: 'decided',
  run: { id: 'run-1' },
  task: { id: 'task-1' },
  attempt: { id: 'attempt-1' },
  decision: { ...pendingDecision, state: 'answered', answer: 'main', revision: 2 },
  cursor: 41,
  inboxId: 'decision:run-1:question-1',
} as const satisfies CliReplyOf<'decided'>;

export const cronJob = {
  id: 'job-nightly',
  title: 'Nightly review',
  revision: 3,
  enabled: true,
  nextDueAt: 1_792_800_000_000,
  createdAt: 1_792_700_000_000,
  schedule: { kind: 'cron', expression: '0 2 * * *', timeZone: 'Europe/Warsaw' },
  calendarState: 'ready',
  calendarError: null,
} as const satisfies JobDefinition;

export const blockedJob = {
  id: 'job-once',
  title: 'Release check',
  revision: 1,
  enabled: true,
  nextDueAt: null,
  createdAt: 1_792_700_100_000,
  schedule: { kind: 'once', at: '2026-11-02T09:00:00+01:00' },
  calendarState: 'blocked',
  calendarError: { code: 'schedule_too_dense', message: 'The schedule is too dense.' },
} as const satisfies JobDefinition;

export const jobSpec = {
  title: 'Nightly review',
  instruction: 'Summarize the current Git changes without editing files.',
  profile: { program: 'claude', workspace: 'shared' },
  schedule: cronJob.schedule,
  retry: { on: 'launchNoEffect', maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 10000 },
  misfire: 'catchUp',
  graceMs: 60000,
  overlap: 'skip',
  maxElapsedMs: 300000,
} as const satisfies NonNullable<JobDefinition['spec']>;

export const retryingOccurrence = {
  id: 'occurrence-2',
  jobId: 'job-nightly',
  jobRevision: 3,
  trigger: 'schedule',
  dueAt: 1_792_713_600_000,
  createdAt: 1_792_713_600_100,
  state: 'retryWaiting',
  reason: 'retry_backoff',
  runId: 'run-9',
  startedAt: 1_792_713_601_000,
  finishedAt: null,
  jobAttemptId: 'job-attempt-1',
  jobAttemptOrdinal: 1,
  retry: {
    jobAttemptId: 'job-attempt-1',
    attemptId: null,
    launchReceiptId: 'receipt-1',
    decidedAt: 1_792_713_602_000,
    notBefore: 1_792_713_603_000,
    nextOrdinal: 2,
    class: 'noEffect',
  },
} as const satisfies JobOccurrence;

export const settledOccurrence = {
  id: 'occurrence-1',
  jobId: 'job-nightly',
  jobRevision: 3,
  trigger: 'manual',
  dueAt: 1_792_627_200_000,
  createdAt: 1_792_627_200_100,
  state: 'succeeded',
  reason: null,
  runId: 'run-8',
  startedAt: 1_792_627_201_000,
  finishedAt: 1_792_627_500_000,
  jobAttemptId: 'job-attempt-0',
  jobAttemptOrdinal: 1,
  retry: null,
} as const satisfies JobOccurrence;

export const jobListReply = {
  type: 'workflow',
  jobs: [cronJob, blockedJob],
  nextOffset: 16,
  page: 0,
  nextPage: 1,
} as const satisfies CliReplyOf<'workflow'>;

export const jobDetailReply = {
  type: 'workflow',
  job: { ...cronJob, spec: jobSpec },
} as const satisfies CliReplyOf<'workflow'>;

export const jobHistoryReply = {
  type: 'workflow',
  occurrences: [retryingOccurrence, settledOccurrence],
  nextOffset: null,
  page: 0,
  nextPage: null,
} as const satisfies CliReplyOf<'workflow'>;

export const wireSession = {
  id: WIRE_SESSION_ID,
  name: 'Shell',
  cwd: '/project',
  createdAt: '2026-10-16T12:00:00Z',
  uptimeSeconds: 42,
  cols: 80,
  rows: 24,
  running: true,
  groupId: null,
  controllerId: null,
  program: 'shell',
  repositoryContext: {
    source: 'launchDirectory',
    state: 'ready',
    name: 'nesvo',
    branch: 'main',
    observedAt: 7,
    revision: 2,
  },
} as const satisfies Session;

export const wireHibernation = {
  state: 'hibernated',
  hibernatedAt: 1_792_785_000_000,
  conversationId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  trigger: 'idlePolicy',
  lastResumeFailure: null,
} as const satisfies SessionHibernation;

export const hibernatedSession = {
  ...wireSession,
  id: 'f'.repeat(32),
  running: false,
  program: 'claude',
  hibernation: wireHibernation,
} as const satisfies Session;

export const sessionsSnapshot = {
  type: 'sessions',
  sessions: [wireSession, hibernatedSession],
  groups: [],
  revision: 4,
} as const satisfies CliReplyOf<'sessions'>;

export const CLI_REPLY_FIXTURES = {
  inboxPage,
  inboxReceipts,
  decisionsPage,
  decidedReply,
  jobListReply,
  jobDetailReply,
  jobHistoryReply,
  sessionsSnapshot,
} as const;
