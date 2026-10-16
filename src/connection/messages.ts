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
function session(value: unknown): value is RecordValue {
  return (
    record(value) &&
    text(value.id) &&
    text(value.name, 320) &&
    text(value.cwd, 32768) &&
    text(value.createdAt) &&
    typeof value.running === 'boolean' &&
    dimensions(value) &&
    nullableId(value.groupId) &&
    (value.controllerId === null || integer(value.controllerId))
  );
}
function group(value: unknown): value is RecordValue {
  return (
    record(value) &&
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
    value.sessions.length > 8 ||
    !value.sessions.every(session)
  )
    return false;
  const groups = value.groups;
  const groupIds = new Set(groups.map((item) => item.id));
  if (
    groupIds.size !== groups.length ||
    new Set(value.sessions.map((item) => item.id)).size !== value.sessions.length
  )
    return false;
  if (value.sessions.some((item) => item.groupId !== null && !groupIds.has(item.groupId)))
    return false;
  for (const item of groups) {
    const ancestors = new Set([item.id]);
    let parentId = item.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) return false;
      const parent = groups.find((candidate) => candidate.id === parentId);
      if (!parent) return false;
      ancestors.add(parentId);
      parentId = parent.parentId;
    }
  }
  return true;
}

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
