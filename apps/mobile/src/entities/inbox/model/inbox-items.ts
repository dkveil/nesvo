import type { InboxItem, InboxMark } from '@shared/api/host';

export const INBOX_PRIORITIES = [3, 2, 1] as const;
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];
export type InboxSection = { priority: InboxPriority; items: InboxItem[] };

export const INBOX_PAGE_LIMIT = 16;
export const MAX_INBOX_PAGE_LIMIT = 32;

export const markKey = ({ id, revision }: InboxMark) => `${id}@${revision}`;

export const sortInboxItems = (items: InboxItem[]) =>
  [...items].sort(
    (left, right) =>
      right.priority - left.priority ||
      right.at - left.at ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );

export const groupInboxItems = (items: InboxItem[]): InboxSection[] =>
  INBOX_PRIORITIES.map(priority => ({
    priority,
    items: items.filter(item => item.priority === priority),
  })).filter(section => section.items.length > 0);

export const mergeInboxPage = (
  current: InboxItem[],
  incoming: InboxItem[],
  replace: boolean,
  pendingMarks: ReadonlySet<string>,
) => {
  const visible = incoming.filter(item => !pendingMarks.has(markKey(item)));
  if (replace) return visible;
  const incomingIds = new Set(visible.map(item => item.id));
  return [...current.filter(item => !incomingIds.has(item.id)), ...visible];
};

export const withoutItems = (items: InboxItem[], removed: InboxItem[]) => {
  const keys = new Set(removed.map(markKey));
  return items.filter(item => !keys.has(markKey(item)));
};

export const restoreItems = (items: InboxItem[], removed: InboxItem[]) => {
  const presentIds = new Set(items.map(item => item.id));
  return sortInboxItems([...items, ...removed.filter(item => !presentIds.has(item.id))]);
};

export const refreshLimit = (loaded: number) =>
  Math.min(MAX_INBOX_PAGE_LIMIT, Math.max(INBOX_PAGE_LIMIT, loaded));
