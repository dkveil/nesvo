import { Buffer } from 'buffer';

import type { ServerMessage } from './types';

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function nullableId(value: unknown): boolean {
  return value === null || text(value);
}
function dimensions(value: RecordValue): boolean {
  return integer(value.cols, 10, 300) && integer(value.rows, 2, 150);
}
function program(value: unknown): boolean {
  return value === 'shell' || value === 'claude' || value === 'gemini' || value === 'codex';
}
function sessionStatus(value: unknown): boolean {
  if (!record(value) || !integer(value.updatedAt)) return false;
  if (
    value.confirmedSource !== undefined &&
    (value.confirmedSource !== 'osc7501' || value.source !== 'screen')
  )
    return false;
  if (value.evidence !== undefined && (value.evidence !== 'hook' || value.source !== 'screen'))
    return false;
  if (value.source === 'activity')
    return value.state === 'working' || value.state === 'idle' || value.state === 'unknown';
  if (value.source === 'process')
    return value.state === 'done' || value.state === 'failed' || value.state === 'unknown';
  return (
    (value.source === 'screen' || value.source === 'hook' || value.source === 'program') &&
    typeof value.state === 'string' &&
    ['working', 'idle', 'done', 'blocked', 'question', 'failed', 'unknown'].includes(value.state)
  );
}
function lifecycle(value: unknown, running: boolean): boolean {
  if (!record(value) || !record(value.process) || !record(value.agent)) return false;
  const { process, agent, turn } = value;
  if (process.running !== running || !(process.pid === null || integer(process.pid, 1)))
    return false;
  const semantic = (status: unknown) =>
    record(status) &&
    typeof status.source === 'string' &&
    !['activity', 'process'].includes(status.source) &&
    sessionStatus(status);
  if (!(agent.current === null || (running && semantic(agent.current)))) return false;
  if (!(agent.lastKnown === null || semantic(agent.lastKnown))) return false;
  if (!(
    agent.blockReason === null ||
    (typeof agent.blockReason === 'string' &&
      ['permission', 'question', 'auth', 'quota', 'setup', 'unknown'].includes(agent.blockReason))
  ))
    return false;
  if (
    typeof agent.freshness !== 'string' ||
    !['observed', 'unknown', 'processExited'].includes(agent.freshness)
  )
    return false;
  if (
    (!running && agent.freshness !== 'processExited') ||
    (agent.freshness === 'observed' && agent.current === null)
  )
    return false;
  return (
    turn === null ||
    (record(turn) &&
      text(turn.id) &&
      integer(turn.generation, 1) &&
      typeof turn.phase === 'string' &&
      ['accepted', 'started', 'waiting', 'settled', 'interrupted', 'failed'].includes(turn.phase) &&
      integer(turn.elapsedSeconds) &&
      integer(turn.observedAt) &&
      (turn.outcome === null || text(turn.outcome, 128)))
  );
}
function capabilities(value: RecordValue): boolean {
  const programs = value.programs;
  const providerLimits = value.providerLimits;
  return (
    (value.hostId === undefined ||
      (typeof value.hostId === 'string' && /^[a-f0-9]{32}$/.test(value.hostId))) &&
    (value.pushNotifications === undefined || typeof value.pushNotifications === 'boolean') &&
    (value.attention === undefined || typeof value.attention === 'boolean') &&
    INBOX_FLAGS.every(flag => value[flag] === undefined || typeof value[flag] === 'boolean') &&
    text(value.workspace, 32768) &&
    Array.isArray(programs) &&
    programs.length === 4 &&
    programs.every(
      (item: unknown) =>
        record(item) &&
        program(item.id) &&
        text(item.label, 80) &&
        typeof item.available === 'boolean',
    ) &&
    new Set(programs.map((item: RecordValue) => item.id)).size === 4 &&
    (providerLimits === undefined ||
      (Array.isArray(providerLimits) &&
        providerLimits.length <= 3 &&
        providerLimits.every(
          (item: unknown) =>
            record(item) &&
            (item.id === 'claude' || item.id === 'gemini' || item.id === 'codex') &&
            (item.status === 'checking' ||
              item.status === 'ready' ||
              item.status === 'unavailable') &&
            Array.isArray(item.windows) &&
            item.windows.length <= 2 &&
            (item.status === 'ready' ? item.windows.length > 0 : item.windows.length === 0) &&
            item.windows.every(
              (window: unknown) =>
                record(window) &&
                integer(window.usedPercent, 0, 100) &&
                integer(window.durationMins, 1, 1_000_000) &&
                (window.resetsAt === null || integer(window.resetsAt)),
            ),
        ) &&
        new Set(providerLimits.map((item: RecordValue) => item.id)).size ===
          providerLimits.length &&
        providerLimits.every((item: RecordValue) =>
          programs.some(
            (program: RecordValue) => program.id === item.id && program.available === true,
          ),
        )))
  );
}
function currentAttention(value: unknown): boolean {
  if (!record(value) || !integer(value.priority, 0, 3) || !integer(value.blockedChildren, 0, 256))
    return false;
  if (value.priority === 0) return value.reason === null && value.status === null;
  return (
    typeof value.reason === 'string' &&
    [
      'permission',
      'question',
      'auth',
      'quota',
      'setup',
      'unknown',
      'startup',
      'failure',
      'child',
    ].includes(value.reason) &&
    sessionStatus(value.status)
  );
}
function attentionSummary(value: unknown): boolean {
  return (
    record(value) &&
    integer(value.sessions) &&
    integer(value.needsYou, 0, value.sessions) &&
    (value.needsYou === 0
      ? value.highest === null
      : record(value.highest) &&
        currentAttention(value.highest) &&
        Number(value.highest.priority) > 0)
  );
}
function repositoryLabel(value: unknown, maxBytes: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  );
}
function repositoryContext(value: unknown): boolean {
  if (!record(value) || value.source !== 'launchDirectory' || !integer(value.revision))
    return false;
  switch (value.state) {
    case 'ready':
      return (
        repositoryLabel(value.name, 128) &&
        repositoryLabel(value.branch, 256) &&
        integer(value.observedAt)
      );
    case 'detached':
      return repositoryLabel(value.name, 128) && value.branch === null && integer(value.observedAt);
    case 'notRepository':
    case 'stale':
      return value.name === null && value.branch === null && integer(value.observedAt);
    case 'checking':
    case 'unavailable':
      return value.name === null && value.branch === null && value.observedAt === null;
    default:
      return false;
  }
}
function session(value: unknown): value is RecordValue {
  return (
    record(value) &&
    text(value.id) &&
    text(value.name, 320) &&
    (value.repositoryContext === undefined || repositoryContext(value.repositoryContext)) &&
    (value.parentSessionId === undefined || nullableId(value.parentSessionId)) &&
    (value.role === undefined || value.role === 'worker' || value.role === 'coordinator') &&
    (value.uptimeSeconds === undefined || integer(value.uptimeSeconds)) &&
    text(value.cwd, 32768) &&
    text(value.createdAt) &&
    typeof value.running === 'boolean' &&
    (value.currentAttention === undefined || currentAttention(value.currentAttention)) &&
    (value.lifecycle === undefined || lifecycle(value.lifecycle, value.running)) &&
    dimensions(value) &&
    (value.program === undefined || program(value.program)) &&
    (value.status === undefined || sessionStatus(value.status)) &&
    (value.readiness === undefined ||
      (record(value.readiness) &&
        typeof value.readiness.initialized === 'boolean' &&
        text(value.readiness.reason, 128) &&
        typeof value.readiness.phase === 'string' &&
        ['notApplicable', 'starting', 'waiting', 'ready', 'timedOut', 'exited'].includes(
          value.readiness.phase,
        ))) &&
    (value.muted === undefined || typeof value.muted === 'boolean') &&
    (value.attention == null ||
      (record(value.attention) &&
        (value.attention.subject === undefined || value.attention.subject === 'response') &&
        (value.attention.turnId === undefined || text(value.attention.turnId)) &&
        integer(value.attention.sequence, 1) &&
        (value.attention.source === undefined ||
          (typeof value.attention.source === 'string' &&
            ['activity', 'screen', 'hook', 'process'].includes(value.attention.source))) &&
        integer(value.attention.at) &&
        typeof value.attention.unread === 'boolean' &&
        typeof value.attention.kind === 'string' &&
        ['question', 'permission', 'done', 'failed', 'limit'].includes(value.attention.kind))) &&
    nullableId(value.groupId) &&
    (value.controllerId === null || integer(value.controllerId))
  );
}
function group(value: unknown): value is RecordValue {
  return (
    record(value) &&
    (value.attentionSummary === undefined || attentionSummary(value.attentionSummary)) &&
    text(value.id) &&
    text(value.name, 320) &&
    nullableId(value.parentId) &&
    integer(value.order, 0, 1_000_000)
  );
}
function snapshot(value: RecordValue): boolean {
  if (
    !integer(value.revision) ||
    !Array.isArray(value.groups) ||
    value.groups.length > 64 ||
    !value.groups.every(group) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length > 16 ||
    !value.sessions.every(session)
  )
    return false;
  const groups = value.groups;
  const groupIds = new Set(groups.map(item => item.id));
  if (
    groupIds.size !== groups.length ||
    new Set(value.sessions.map(item => item.id)).size !== value.sessions.length
  )
    return false;
  if (value.sessions.some(item => item.groupId !== null && !groupIds.has(item.groupId)))
    return false;
  for (const item of groups) {
    const ancestors = new Set([item.id]);
    let parentId = item.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) return false;
      const parent = groups.find(candidate => candidate.id === parentId);
      if (!parent) return false;
      ancestors.add(parentId);
      parentId = parent.parentId;
    }
  }
  return true;
}

const INBOX_FLAGS = ['attentionInbox', 'decisions', 'jobPages'] as const;
const INBOX_KINDS = ['session', 'decision', 'run', 'result'];
const DECISION_STATES = ['pending', 'answered', 'canceled', 'expired'];
const MAX_ITEM_ID_LENGTH = 200;
const MAX_INBOX_TEXT_LENGTH = 4096;
const MAX_QUESTION_LENGTH = 32768;

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;
const nextPage = (value: unknown, max: number) => value === null || integer(value, 1, max);
const itemId = (value: unknown): value is string =>
  text(value, MAX_ITEM_ID_LENGTH) && !/[\u0000-\u001f\u007f]/.test(value);
const optional = (value: unknown, check: (item: unknown) => boolean) =>
  value === undefined || check(value);

const inboxItem = (value: unknown): value is RecordValue =>
  record(value) &&
  itemId(value.id) &&
  typeof value.kind === 'string' &&
  INBOX_KINDS.includes(value.kind) &&
  value.id.startsWith(`${value.kind}:`) &&
  value.id.length > value.kind.length + 1 &&
  integer(value.revision) &&
  integer(value.priority, 1, 3) &&
  text(value.reason, 128) &&
  integer(value.at) &&
  boundedString(value.title, MAX_INBOX_TEXT_LENGTH) &&
  optional(value.summary, item => boundedString(item, MAX_INBOX_TEXT_LENGTH)) &&
  optional(value.sessionId, item => text(item)) &&
  optional(value.decisionId, item => text(item)) &&
  optional(value.runId, nullableId) &&
  optional(value.expiresAt, item => integer(item)) &&
  optional(value.program, item => item === 'claude' || item === 'gemini' || item === 'codex');

const attentionInbox = (value: RecordValue) =>
  Array.isArray(value.items) &&
  integer(value.page, 0, 1024) &&
  integer(value.limit, 1, 32) &&
  value.items.length <= value.limit &&
  value.items.every(inboxItem) &&
  new Set(value.items.map(item => item.id)).size === value.items.length &&
  nextPage(value.nextPage, 1025) &&
  integer(value.total);

const inboxReceipt = (value: unknown) =>
  record(value) && itemId(value.id) && integer(value.revision) && integer(value.acknowledgedAt);

const decisionRun = (value: unknown) =>
  record(value) &&
  text(value.id) &&
  boundedString(value.title, MAX_INBOX_TEXT_LENGTH) &&
  boundedString(value.state, 64);

const choices = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= 8 &&
  value.every(item => text(item, 200)) &&
  new Set(value).size === value.length;

const pendingDecision = (value: unknown) =>
  record(value) &&
  text(value.id) &&
  text(value.runId) &&
  text(value.taskId) &&
  text(value.attemptId) &&
  boundedString(value.question, MAX_QUESTION_LENGTH) &&
  integer(value.revision, 1) &&
  typeof value.state === 'string' &&
  DECISION_STATES.includes(value.state) &&
  (value.audience === 'owner' || value.audience === 'coordinator') &&
  integer(value.createdAt) &&
  integer(value.expiresAt) &&
  (value.answer === null || boundedString(value.answer, MAX_QUESTION_LENGTH)) &&
  itemId(value.inboxId) &&
  value.inboxId.startsWith('decision:') &&
  decisionRun(value.run) &&
  optional(value.choices, choices);

const decisions = (value: RecordValue) =>
  Array.isArray(value.decisions) &&
  value.decisions.length <= 32 &&
  value.decisions.every(pendingDecision) &&
  integer(value.page, 0, 512) &&
  nextPage(value.nextPage, 513) &&
  integer(value.total);

const decided = (value: RecordValue) =>
  record(value.decision) &&
  text(value.decision.id) &&
  integer(value.decision.revision, 1) &&
  typeof value.decision.state === 'string' &&
  DECISION_STATES.includes(value.decision.state) &&
  itemId(value.inboxId) &&
  value.inboxId.startsWith('decision:');

/** Authentication proves the peer, not that its payload has a valid shape. */
export function decodeServerMessage(value: unknown): ServerMessage {
  if (
    !record(value) ||
    !text(value.type, 40) ||
    (value.requestId !== undefined && !text(value.requestId))
  ) {
    throw new Error('Invalid host message.');
  }
  let valid = false;
  switch (value.type) {
    case 'pushRegistered':
      valid =
        typeof value.enabled === 'boolean' &&
        optional(
          value.kinds,
          kinds => Array.isArray(kinds) && kinds.length <= 8 && kinds.every(kind => text(kind, 64)),
        );
      break;
    case 'attentionInbox':
      valid = attentionInbox(value);
      break;
    case 'inboxAcknowledged':
      valid =
        Array.isArray(value.acknowledged) &&
        value.acknowledged.length >= 1 &&
        value.acknowledged.length <= 32 &&
        value.acknowledged.every(inboxReceipt);
      break;
    case 'decisions':
      valid = decisions(value);
      break;
    case 'decided':
      valid = decided(value);
      break;
    case 'attentionInboxChanged':
      valid = text(value.reason, 64) && optional(value.itemId, itemId);
      break;
    case 'capabilities':
      valid = capabilities(value);
      break;
    case 'connected':
      valid =
        value.protocolVersion === 2 &&
        integer(value.clientId) &&
        typeof value.clientNonce === 'string' &&
        /^[a-f0-9]{64}$/.test(value.clientNonce);
      break;
    case 'sessions':
      valid = snapshot(value);
      break;
    case 'created':
    case 'attached':
    case 'unsubscribed':
      valid = text(value.sessionId);
      break;
    case 'groupCreated':
      valid = text(value.groupId) && integer(value.revision);
      break;
    case 'updated':
      valid = integer(value.revision);
      break;
    case 'subscribed':
      valid = text(value.sessionId) && dimensions(value);
      break;
    case 'control':
      valid =
        text(value.sessionId) &&
        dimensions(value) &&
        (value.controllerId === null || integer(value.controllerId)) &&
        (value.leaseId === undefined || (value.controllerId !== null && text(value.leaseId)));
      break;
    case 'output':
      valid =
        text(value.sessionId) &&
        typeof value.data === 'string' &&
        value.data.length <= 1_048_576 &&
        (value.replay === undefined || typeof value.replay === 'boolean') &&
        (value.allowResponses === undefined || typeof value.allowResponses === 'boolean');
      break;
    case 'error':
      valid =
        text(value.message, 32768) &&
        (value.code === undefined || text(value.code)) &&
        (value.revision === undefined || integer(value.revision));
      break;
  }
  if (!valid) throw new Error('Invalid host message.');
  // Every field consumed by state/UI has been checked above; extras are ignored.
  return value as ServerMessage;
}
