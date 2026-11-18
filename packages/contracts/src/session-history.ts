import { z } from 'zod';
import {
  sessionMessageSchema,
  sessionSchema,
  type Session,
  type TurnUsage,
} from './sessions';

export const sessionHistoryLimits = {
  tail: 2,
  page: 40,
  maxPage: 200,
  pageCharacters: 4_000_000,
} as const;

const countSchema = z.number().int().nonnegative();

export const sessionUsageTotalsSchema = z.strictObject({
  turns: countSchema,
  reportedTurns: countSchema,
  inputTokens: countSchema,
  outputTokens: countSchema,
  last: z
    .strictObject({
      inputTokens: countSchema.nullable(),
      outputTokens: countSchema.nullable(),
    })
    .nullable(),
  costUsd: z.number().nonnegative().nullable(),
  costTurns: countSchema,
});
export type SessionUsageTotals = z.infer<typeof sessionUsageTotalsSchema>;

export const sessionWindowSchema = sessionSchema.extend({
  messageCount: countSchema,
  usageTotals: sessionUsageTotalsSchema,
});
export type SessionWindow = z.infer<typeof sessionWindowSchema>;

export const sessionMetadataSchema = sessionWindowSchema.omit({
  messages: true,
});
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;

export const sessionMessageUpsertSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  session: sessionMetadataSchema,
  index: z.number().int().nonnegative(),
  message: sessionMessageSchema,
});
export type SessionMessageUpsert = z.infer<typeof sessionMessageUpsertSchema>;

const pageLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(sessionHistoryLimits.maxPage);

export const getSessionSchema = z.strictObject({
  sessionId: z.uuid(),
  limit: pageLimitSchema.optional(),
});
export type GetSessionInput = z.infer<typeof getSessionSchema>;

export const readSessionMessagesSchema = z.strictObject({
  sessionId: z.uuid(),
  cursor: z.uuid(),
  limit: pageLimitSchema.optional(),
});
export type ReadSessionMessagesInput = z.infer<
  typeof readSessionMessagesSchema
>;

export const sessionMessagePageSchema = z.strictObject({
  sessionId: z.uuid(),
  revision: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  startIndex: z.number().int().nonnegative(),
  messages: z.array(sessionMessageSchema).max(sessionHistoryLimits.maxPage),
  nextCursor: z.uuid().nullable(),
});
export type SessionMessagePage = z.infer<typeof sessionMessagePageSchema>;

type Windowed = Pick<SessionWindow, 'messages' | 'messageCount'>;

export const windowOffset = (session: Windowed) =>
  session.messageCount - session.messages.length;

export const hasEarlierMessages = (session: Windowed) =>
  windowOffset(session) > 0;

const pageStart = (
  messages: Session['messages'],
  end: number,
  limit: number,
) => {
  let start = end;
  let characters = 0;
  while (start > 0 && end - start < limit) {
    characters += messages[start - 1]!.body.length;
    if (start < end && characters > sessionHistoryLimits.pageCharacters) break;
    start -= 1;
  }
  return start;
};

type UsageEntry = {
  author: Session['messages'][number]['author'];
  usage: TurnUsage | null;
};

export const summarizeSessionUsage = (
  entries: UsageEntry[],
): SessionUsageTotals => {
  const used = entries.filter(entry => entry.usage);
  const last = used.findLast(entry => entry.author === 'agent')?.usage;
  const costs = entries.flatMap(entry =>
    entry.author === 'agent' &&
    entry.usage?.source === 'provider-report' &&
    entry.usage.costUsd !== null
      ? [entry.usage.costUsd]
      : [],
  );
  const sum = (pick: (usage: TurnUsage) => number | null) =>
    used.reduce((total, entry) => total + (pick(entry.usage!) ?? 0), 0);
  return {
    turns: entries.filter(entry => entry.author === 'agent').length,
    reportedTurns: used.length,
    inputTokens: sum(usage => usage.inputTokens),
    outputTokens: sum(usage => usage.outputTokens),
    last: last
      ? { inputTokens: last.inputTokens, outputTokens: last.outputTokens }
      : null,
    costUsd: costs.length
      ? costs.reduce((total, cost) => total + cost, 0)
      : null,
    costTurns: costs.length,
  };
};

export const toSessionWindow = (
  session: Session,
  limit: number = sessionHistoryLimits.tail,
): SessionWindow => ({
  ...session,
  messages: session.messages.slice(
    pageStart(session.messages, session.messages.length, limit),
  ),
  messageCount: session.messages.length,
  usageTotals: summarizeSessionUsage(session.messages),
});

export const toSessionMetadata = (session: Session): SessionMetadata => {
  const { messages, ...metadata } = session;
  return {
    ...metadata,
    messageCount: messages.length,
    usageTotals: summarizeSessionUsage(messages),
  };
};

export const toSessionMessagePage = (
  session: Session,
  cursor: string,
  limit: number = sessionHistoryLimits.page,
): SessionMessagePage | null => {
  const end = session.messages.findIndex(message => message.id === cursor);
  if (end < 0) return null;
  const start = pageStart(session.messages, end, limit);
  return {
    sessionId: session.id,
    revision: session.revision,
    messageCount: session.messages.length,
    startIndex: start,
    messages: session.messages.slice(start, end),
    nextCursor: start > 0 ? session.messages[start]!.id : null,
  };
};

export const trimSessionWindow = <T extends SessionWindow>(
  session: T,
  limit: number = sessionHistoryLimits.tail,
): T =>
  session.messages.length <= limit
    ? session
    : { ...session, messages: session.messages.slice(-limit) };

export type SessionChange<T extends SessionWindow = SessionWindow> =
  | { type: 'snapshot'; session: T }
  | {
      type: 'upsert';
      baseRevision: number;
      session: Omit<T, 'messages'>;
      index: number;
      message: Session['messages'][number];
    };

export type AppliedSessionChange<T extends SessionWindow> = {
  session: T;
  gap: boolean;
};

const mergeSnapshot = <T extends SessionWindow>(
  current: T,
  next: T,
): AppliedSessionChange<T> => {
  const currentOffset = windowOffset(current);
  const nextOffset = windowOffset(next);
  if (nextOffset <= currentOffset) return { session: next, gap: false };
  const overlapping =
    nextOffset <= current.messageCount &&
    next.messageCount >= current.messageCount &&
    (nextOffset === current.messageCount ||
      current.messages[nextOffset - currentOffset]?.id ===
        next.messages[0]?.id);
  if (!overlapping) return { session: next, gap: true };
  return {
    session: {
      ...next,
      messages: [
        ...current.messages.slice(0, nextOffset - currentOffset),
        ...next.messages,
      ],
    },
    gap: false,
  };
};

const mergeUpsert = <T extends SessionWindow>(
  current: T | undefined,
  change: Extract<SessionChange<T>, { type: 'upsert' }>,
): AppliedSessionChange<T> => {
  const { session, index, message } = change;
  const fallback = {
    session: {
      ...session,
      messages: index === session.messageCount - 1 ? [message] : [],
    } as T,
    gap: true,
  };
  if (!current || current.revision !== change.baseRevision) return fallback;
  if (index > current.messageCount || session.messageCount < index + 1)
    return fallback;
  const offset = windowOffset(current);
  const messages =
    index < offset
      ? current.messages
      : index === current.messageCount
        ? [...current.messages, message]
        : current.messages.map((item, position) =>
            position === index - offset ? message : item,
          );
  if (offset + messages.length !== session.messageCount) return fallback;
  return { session: { ...session, messages } as T, gap: false };
};

export const applySessionChange = <T extends SessionWindow>(
  current: T | undefined,
  change: SessionChange<T>,
): AppliedSessionChange<T> | null => {
  if (current && current.revision >= change.session.revision) return null;
  if (change.type === 'upsert') return mergeUpsert(current, change);
  return current
    ? mergeSnapshot(current, change.session)
    : { session: change.session, gap: false };
};

export const prependSessionMessages = <T extends SessionWindow>(
  current: T,
  page: SessionMessagePage,
): T | null => {
  if (
    page.sessionId !== current.id ||
    page.startIndex + page.messages.length !== windowOffset(current)
  )
    return null;
  return { ...current, messages: [...page.messages, ...current.messages] };
};
