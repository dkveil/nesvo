import Ajv from 'ajv';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { decodeServerMessage } from '../apps/mobile/src/shared/api/host/messages';
import type {
  HostEvent,
  InboxItem,
  JobOccurrence,
  JobSchedule,
  JobSummary,
  PendingDecision,
} from '../apps/mobile/src/shared/api/host/types';
import {
  blockedJob,
  CLI_REPLY_FIXTURES,
  cronJob,
  decidedReply,
  decisionsPage,
  hibernatedSession,
  inboxDecisionItem,
  inboxPage,
  inboxReceipt,
  inboxReceipts,
  inboxResultItem,
  inboxRunItem,
  inboxSessionItem,
  jobDetailReply,
  jobHistoryReply,
  jobListReply,
  jobSpec,
  pendingDecision,
  retryingOccurrence,
  sessionsSnapshot,
  settledOccurrence,
  wireHibernation,
  wireSession,
} from './fixtures/mobile-wire-fixtures';

type SchemaNode = {
  const?: unknown;
  enum?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  definitions?: Record<string, SchemaNode>;
};

const readSchema = (name: string): SchemaNode =>
  JSON.parse(readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8'));

const CLI_SCHEMA = readSchema('harness-cli.schema.json');
const EVENTS_SCHEMA = readSchema('harness-events.schema.json');
const validateCli = new Ajv().compile(CLI_SCHEMA);

const isPublished = (data: unknown) => validateCli({ schemaVersion: 1, ok: true, data });
const assertPublished = (data: unknown, label: string) =>
  assert.equal(isPublished(data), true, `${label}: ${JSON.stringify(validateCli.errors)}`);
const assertUnpublished = (data: unknown, label: string) =>
  assert.equal(isPublished(data), false, `${label} unexpectedly matches the published schema`);
const assertRejected = (frame: unknown, label: string) =>
  assert.throws(() => decodeServerMessage(frame), /Invalid host message/, label);

const definition = (schema: SchemaNode, name: string) => {
  const found = schema.definitions?.[name];
  assert.ok(found, `definition ${name}`);
  return found;
};
const enumOf = (node: SchemaNode | undefined, label: string) => {
  assert.ok(node?.enum && node.enum.length > 0, `${label} is an enum`);
  return node.enum;
};
const replyBranch = (type: string) => {
  const data = CLI_SCHEMA.oneOf?.find(branch => branch.properties?.data)?.properties?.data;
  const found = data?.oneOf?.find(branch => branch.properties?.type?.const === type);
  assert.ok(found, `reply branch ${type}`);
  return found;
};
const definitionEnum = (schema: SchemaNode, name: string, property: string) =>
  enumOf(definition(schema, name).properties?.[property], `${name}.${property}`);

type InboxPageEvent = Extract<HostEvent, { type: 'attentionInbox' }>;
type DecisionsEvent = Extract<HostEvent, { type: 'decisions' }>;
type JobPageEvent = Extract<HostEvent, { type: 'jobPage' }>;
type JobHistoryEvent = Extract<HostEvent, { type: 'jobHistory' }>;
type JobDetailEvent = Extract<HostEvent, { type: 'jobDetail' }>;
type SessionsEvent = Extract<HostEvent, { type: 'sessions' }>;

const decodeInbox = (items: unknown[]) =>
  decodeServerMessage({ ...inboxPage, items }) as InboxPageEvent;
const decodeJobs = (jobs: unknown[]) =>
  decodeServerMessage({ ...jobListReply, jobs }) as JobPageEvent;
const decodeHistory = (occurrences: unknown[]) =>
  decodeServerMessage({ ...jobHistoryReply, occurrences }) as JobHistoryEvent;
const decodeSessions = (sessions: unknown[]) =>
  decodeServerMessage({ ...sessionsSnapshot, sessions }) as SessionsEvent;
const withoutKey = <TValue extends object>(value: TValue, key: keyof TValue) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

test('typed mobile wire fixtures match the published CLI schema with and without a request ID', () => {
  for (const [name, data] of Object.entries(CLI_REPLY_FIXTURES)) {
    assertPublished(data, name);
    assertPublished({ ...data, requestId: `${name}-1` }, `${name} with requestId`);
  }
});

test('typed mobile wire fixtures decode into the client models', () => {
  const page = decodeServerMessage({ ...inboxPage, requestId: 'inbox-1' }) as InboxPageEvent;
  const items: InboxItem[] = [inboxSessionItem, inboxDecisionItem, inboxRunItem, inboxResultItem];
  assert.deepEqual(page.items, items);
  assert.equal(page.skipped, undefined);
  assert.deepEqual(decodeServerMessage(inboxReceipts), inboxReceipts);
  const decisions = decodeServerMessage(decisionsPage) as DecisionsEvent;
  const decision: PendingDecision = pendingDecision;
  assert.deepEqual(decisions.decisions, [decision]);
  assert.deepEqual(decodeServerMessage(decidedReply), decidedReply);
  const jobs: JobSummary[] = [cronJob, blockedJob];
  assert.deepEqual(decodeJobs(jobs).jobs, jobs);
  const occurrences: JobOccurrence[] = [retryingOccurrence, settledOccurrence];
  assert.deepEqual(decodeHistory(occurrences).occurrences, occurrences);
  assert.deepEqual((decodeServerMessage(jobDetailReply) as JobDetailEvent).job, jobDetailReply.job);
  assert.deepEqual(decodeServerMessage(sessionsSnapshot), sessionsSnapshot);
});

test('every published inbox kind, item program and decision state decodes as known', () => {
  for (const kind of definitionEnum(CLI_SCHEMA, 'attentionItem', 'kind')) {
    const item = { ...inboxSessionItem, kind, id: `${kind}:published` };
    assertPublished({ ...inboxPage, items: [item] }, `inbox kind ${kind}`);
    const page = decodeInbox([item]);
    assert.deepEqual(page.items, [item], kind);
    assert.equal(page.skipped, undefined, kind);
  }
  for (const program of definitionEnum(CLI_SCHEMA, 'attentionItem', 'program')) {
    const item = { ...inboxSessionItem, program };
    assert.deepEqual(decodeInbox([item]).items, [item], program);
  }
  const decisionItem = replyBranch('decisions').properties?.decisions?.items;
  for (const state of enumOf(decisionItem?.properties?.state, 'decision state')) {
    const decision = { ...pendingDecision, state };
    const page = decodeServerMessage({ ...decisionsPage, decisions: [decision] }) as DecisionsEvent;
    assert.deepEqual(page.decisions, [decision], state);
    assert.equal(page.skipped, undefined, state);
  }
});

test('every published job schedule, calendar state, occurrence state and retry class decodes as known', () => {
  const schedules = {
    once: { kind: 'once', at: '2026-11-02T09:00:00+01:00' },
    cron: { kind: 'cron', expression: '0 2 * * *', timeZone: 'UTC' },
    rrule: { kind: 'rrule', rule: 'FREQ=WEEKLY', start: '2026-11-02T09:00:00', timeZone: 'UTC' },
    external: { kind: 'external' },
  } as const satisfies { [TKind in JobSchedule['kind']]: Extract<JobSchedule, { kind: TKind }> };
  const scheduleBranches = definition(CLI_SCHEMA, 'jobDefinition').properties?.schedule?.oneOf;
  assert.deepEqual(
    scheduleBranches?.map(branch => branch.properties?.kind?.const).sort(),
    Object.keys(schedules).sort(),
  );
  for (const schedule of Object.values(schedules)) {
    const job = { ...cronJob, schedule };
    assertPublished({ ...jobListReply, jobs: [job] }, `schedule ${schedule.kind}`);
    assert.deepEqual(decodeJobs([job]).jobs, [job], schedule.kind);
  }
  for (const calendarState of definitionEnum(CLI_SCHEMA, 'jobDefinition', 'calendarState')) {
    const job = { ...cronJob, calendarState };
    assert.deepEqual(decodeJobs([job]).jobs, [job], calendarState);
  }
  for (const state of definitionEnum(CLI_SCHEMA, 'jobOccurrence', 'state')) {
    const occurrence = { ...settledOccurrence, state };
    const history = decodeHistory([occurrence]);
    assert.deepEqual(history.occurrences, [occurrence], state);
    assert.equal(history.skipped, undefined, state);
  }
  for (const retryClass of definitionEnum(CLI_SCHEMA, 'jobRetryDecision', 'class')) {
    const occurrence = {
      ...retryingOccurrence,
      retry: { ...retryingOccurrence.retry, class: retryClass },
    };
    assert.deepEqual(decodeHistory([occurrence]).occurrences, [occurrence], retryClass);
  }
});

test('every published session program, agent state and hibernation trigger decodes as known', () => {
  const programs = definitionEnum(CLI_SCHEMA, 'session', 'program');
  assert.deepEqual(
    [...programs].sort(),
    [...enumOf(definition(EVENTS_SCHEMA, 'Program'), 'Program')].sort(),
  );
  for (const program of programs) {
    const session = { ...wireSession, program };
    assert.deepEqual(decodeSessions([session]).sessions, [session], program);
  }
  for (const state of enumOf(definition(EVENTS_SCHEMA, 'AgentState'), 'AgentState')) {
    const session = { ...wireSession, status: { state, source: 'screen', updatedAt: 1 } };
    assert.deepEqual(decodeSessions([session]).sessions, [session], state);
  }
  for (const trigger of definitionEnum(CLI_SCHEMA, 'sessionHibernation', 'trigger')) {
    const session = { ...hibernatedSession, hibernation: { ...wireHibernation, trigger } };
    assertPublished({ ...sessionsSnapshot, sessions: [session] }, `trigger ${trigger}`);
    assert.deepEqual(decodeSessions([session]).sessions, [session], trigger);
  }
});

test('inbox items ignore unknown fields, skip unknown kinds, omit unknown programs and refuse malformed fields', () => {
  const extended = { ...inboxSessionItem, futureHint: 'grouped' };
  assertPublished({ ...inboxPage, items: [extended] }, 'inbox item with an unknown field');
  assert.deepEqual(decodeInbox([extended]).items, [extended]);
  const futureKind = { ...inboxSessionItem, kind: 'review', id: 'review:1' };
  assertUnpublished({ ...inboxPage, items: [futureKind] }, 'unknown inbox kind');
  const skipped = decodeInbox([futureKind, inboxRunItem]);
  assert.deepEqual(skipped.items, [inboxRunItem]);
  assert.equal(skipped.skipped, 1);
  const withoutProgram = withoutKey(inboxSessionItem, 'program');
  for (const program of ['aider', 'shell']) {
    const item = { ...inboxSessionItem, program };
    assertUnpublished({ ...inboxPage, items: [item] }, `inbox program ${program}`);
    assert.deepEqual(decodeInbox([item]).items, [withoutProgram], program);
  }
  for (const [label, item] of [
    ['priority', { ...inboxSessionItem, priority: 'high' }],
    ['revision', { ...inboxSessionItem, revision: -1 }],
    ['jobId', { ...inboxResultItem, jobId: '' }],
    ['occurrenceId', { ...inboxResultItem, occurrenceId: 7 }],
    ['taskId', { ...inboxRunItem, taskId: null }],
  ] as const) {
    assertUnpublished({ ...inboxPage, items: [item] }, `malformed inbox ${label}`);
    assertRejected({ ...inboxPage, items: [item] }, `malformed inbox ${label}`);
  }
});

test('inbox receipts ignore unknown fields and refuse malformed fields', () => {
  const extended = { ...inboxReceipt, source: 'phone' };
  assertUnpublished({ ...inboxReceipts, acknowledged: [extended] }, 'closed receipt');
  assert.deepEqual(decodeServerMessage({ ...inboxReceipts, acknowledged: [extended] }), {
    ...inboxReceipts,
    acknowledged: [extended],
  });
  const malformed = { ...inboxReceipts, acknowledged: [{ ...inboxReceipt, acknowledgedAt: -1 }] };
  assertUnpublished(malformed, 'malformed receipt');
  assertRejected(malformed, 'malformed receipt');
});

test('decisions ignore unknown fields, skip unknown states and refuse malformed fields', () => {
  const extended = { ...pendingDecision, priority: 'high' };
  assertPublished({ ...decisionsPage, decisions: [extended] }, 'decision with an unknown field');
  assert.deepEqual(
    (decodeServerMessage({ ...decisionsPage, decisions: [extended] }) as DecisionsEvent).decisions,
    [extended],
  );
  const superseded = { ...pendingDecision, id: 'question-0', state: 'superseded' };
  assertUnpublished({ ...decisionsPage, decisions: [superseded] }, 'unknown decision state');
  const page = decodeServerMessage({
    ...decisionsPage,
    decisions: [superseded, pendingDecision],
  }) as DecisionsEvent;
  assert.deepEqual(page.decisions, [pendingDecision]);
  assert.equal(page.skipped, 1);
  const supersededReply = {
    ...decidedReply,
    decision: { ...decidedReply.decision, state: 'superseded' },
  };
  assertUnpublished(supersededReply, 'unknown decided state');
  assert.deepEqual(decodeServerMessage(supersededReply), supersededReply);
  for (const [label, frame] of [
    ['audience', { ...decisionsPage, decisions: [{ ...pendingDecision, audience: 'everyone' }] }],
    ['revision', { ...decisionsPage, decisions: [{ ...pendingDecision, revision: 0 }] }],
    ['decided inboxId', { ...decidedReply, inboxId: 'session:x' }],
  ] as const) {
    assertUnpublished(frame, `malformed ${label}`);
    assertRejected(frame, `malformed ${label}`);
  }
});

test('job pages ignore unknown fields, null unknown schedules and calendar states and refuse malformed fields', () => {
  const extended = { ...cronJob, owner: 'release' };
  assertPublished({ ...jobListReply, jobs: [extended] }, 'job with an unknown field');
  assert.deepEqual(decodeJobs([extended]).jobs, [extended]);
  const future = {
    ...cronJob,
    schedule: { kind: 'interval', everyMs: 60000 },
    calendarState: 'paused',
  };
  assertUnpublished({ ...jobListReply, jobs: [future] }, 'unknown schedule and calendar state');
  assert.deepEqual(decodeJobs([future, blockedJob]).jobs, [
    { ...future, schedule: null, calendarState: null },
    blockedJob,
  ]);
  for (const [label, job] of [
    ['revision', { ...cronJob, revision: 0 }],
    ['enabled', { ...cronJob, enabled: 'yes' }],
    ['schedule', { ...cronJob, schedule: { kind: 'cron', expression: '* * * * *' } }],
    ['calendarError', { ...cronJob, calendarError: { code: 'schedule_too_dense' } }],
  ] as const) {
    assertUnpublished({ ...jobListReply, jobs: [job] }, `malformed job ${label}`);
    assertRejected({ ...jobListReply, jobs: [job] }, `malformed job ${label}`);
  }
});

test('job history ignores unknown fields, skips unknown states, omits unknown retry classes and refuses malformed fields', () => {
  const extended = { ...settledOccurrence, sessionId: 'session-1', launchReceiptId: 'receipt-0' };
  assertPublished({ ...jobHistoryReply, occurrences: [extended] }, 'occurrence with extras');
  assert.deepEqual(decodeHistory([extended]).occurrences, [extended]);
  const archived = { ...settledOccurrence, id: 'occurrence-0', state: 'archived' };
  assertUnpublished({ ...jobHistoryReply, occurrences: [archived] }, 'unknown occurrence state');
  const history = decodeHistory([archived, settledOccurrence]);
  assert.deepEqual(history.occurrences, [settledOccurrence]);
  assert.equal(history.skipped, 1);
  for (const retryClass of ['definiteEffect', 'partialEffect']) {
    const occurrence = {
      ...retryingOccurrence,
      retry: { ...retryingOccurrence.retry, class: retryClass },
    };
    assertUnpublished({ ...jobHistoryReply, occurrences: [occurrence] }, retryClass);
    assert.deepEqual(decodeHistory([occurrence]).occurrences, [
      { ...retryingOccurrence, retry: withoutKey(retryingOccurrence.retry, 'class') },
    ]);
  }
  for (const [label, occurrence] of [
    ['jobAttemptOrdinal', { ...settledOccurrence, jobAttemptOrdinal: 0 }],
    ['reason', { ...settledOccurrence, reason: 7 }],
    ['state', { ...settledOccurrence, state: 7 }],
  ] as const) {
    assertUnpublished({ ...jobHistoryReply, occurrences: [occurrence] }, `malformed ${label}`);
    assertRejected({ ...jobHistoryReply, occurrences: [occurrence] }, `malformed ${label}`);
  }
});

test('job detail omits an unknown profile program and refuses a malformed retry policy', () => {
  const futureProgram = {
    ...jobDetailReply,
    job: { ...cronJob, spec: { ...jobSpec, profile: { ...jobSpec.profile, program: 'aider' } } },
  };
  assertPublished(futureProgram, 'job profile program is open in the schema');
  assert.deepEqual((decodeServerMessage(futureProgram) as JobDetailEvent).job, {
    ...cronJob,
    spec: { ...jobSpec, profile: withoutKey(jobSpec.profile, 'program') },
  });
  const malformed = {
    ...jobDetailReply,
    job: { ...cronJob, spec: { ...jobSpec, retry: { on: 'launchNoEffect' } } },
  };
  assertUnpublished(malformed, 'malformed retry policy');
  assertRejected(malformed, 'malformed retry policy');
});

test('session snapshots ignore unknown fields and refuse unknown programs, triggers and malformed fields', () => {
  const extended = { ...wireSession, futureHint: 1 };
  assertPublished({ ...sessionsSnapshot, sessions: [extended] }, 'session with an unknown field');
  assert.deepEqual(decodeSessions([extended]).sessions, [extended]);
  for (const [label, session] of [
    ['program', { ...wireSession, program: 'aider' }],
    ['cols', { ...wireSession, cols: 5 }],
    ['trigger', { ...hibernatedSession, hibernation: { ...wireHibernation, trigger: 'timer' } }],
    [
      'hibernatedAt',
      { ...hibernatedSession, hibernation: { ...wireHibernation, hibernatedAt: -1 } },
    ],
  ] as const) {
    assertUnpublished({ ...sessionsSnapshot, sessions: [session] }, `malformed session ${label}`);
    assertRejected({ ...sessionsSnapshot, sessions: [session] }, `malformed session ${label}`);
  }
});

test('job definitions without the optional calendar fields decode with null calendar values', () => {
  const calendarless = withoutKey(withoutKey(cronJob, 'calendarState'), 'calendarError');
  assertPublished({ ...jobListReply, jobs: [calendarless] }, 'job without calendar fields');
  assert.deepEqual(decodeJobs([calendarless]).jobs, [
    { ...calendarless, calendarState: null, calendarError: null },
  ]);
  const detail = { ...jobDetailReply, job: { ...calendarless, spec: jobSpec } };
  assert.deepEqual((decodeServerMessage(detail) as JobDetailEvent).job, {
    ...calendarless,
    calendarState: null,
    calendarError: null,
    spec: jobSpec,
  });
});
