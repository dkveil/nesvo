export type PushTarget = { hostId: string; sessionId: string; sequence: number };
export type InboxPushKind = 'decisionPending' | 'resultReady';
export type InboxPushTarget = { hostId: string; kind: InboxPushKind; itemId: string };
export type NotificationTarget =
  { type: 'session'; target: PushTarget } | { type: 'inbox'; target: InboxPushTarget };

const HOST_ID_PATTERN = /^[a-f0-9]{32}$/;
const INBOX_ITEM_PATTERN = /^(session|decision|run|result):[^\u0000- \u007f]{1,190}$/;

export function parseTarget(value: unknown): PushTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  return typeof v.hostId === 'string' &&
    /^[a-f0-9]{32}$/.test(v.hostId) &&
    typeof v.sessionId === 'string' &&
    /^[a-f0-9]{32}$/.test(v.sessionId) &&
    typeof v.sequence === 'number' &&
    Number.isSafeInteger(v.sequence) &&
    v.sequence > 0
    ? { hostId: v.hostId, sessionId: v.sessionId, sequence: v.sequence }
    : null;
}

export const parseInboxTarget = (value: unknown): InboxPushTarget | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { hostId, kind, itemId } = value as Record<string, unknown>;
  return typeof hostId === 'string' &&
    HOST_ID_PATTERN.test(hostId) &&
    (kind === 'decisionPending' || kind === 'resultReady') &&
    typeof itemId === 'string' &&
    INBOX_ITEM_PATTERN.test(itemId)
    ? { hostId, kind, itemId }
    : null;
};

export const parseNotificationTarget = (value: unknown): NotificationTarget | null => {
  const session = parseTarget(value);
  if (session) return { type: 'session', target: session };
  const inbox = parseInboxTarget(value);
  return inbox ? { type: 'inbox', target: inbox } : null;
};
