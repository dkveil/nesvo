import { providers, type Provider } from '@/entities/session';

export type AssistantPick = {
  provider: Provider;
  model: string;
  effort: string;
};
export type AssistantTurn = { messageId: string; text: string };
export type AssistantConversation = {
  sessionId: string;
  title: string;
  at: string;
};

type Saved = {
  collapsed: boolean;
  picks: Record<string, AssistantPick>;
  sessions: Record<string, string>;
  conversations: Record<string, AssistantConversation[]>;
  turns: Record<string, AssistantTurn[]>;
};

const key = 'nesvo.workflow-assistant.v2';
const identifier = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxSessions = 40;
const maxConversations = 20;
const maxTurns = 40;
const maxText = 8000;
const maxTitle = 120;

const empty = (): Saved => ({
  collapsed: true,
  picks: {},
  sessions: {},
  conversations: {},
  turns: {},
});

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const pickFrom = (value: unknown): AssistantPick | null => {
  const item = record(value);
  return providers.includes(item.provider as Provider) &&
    typeof item.model === 'string' &&
    item.model.length <= 200 &&
    typeof item.effort === 'string' &&
    item.effort.length <= 40
    ? {
        provider: item.provider as Provider,
        model: item.model,
        effort: item.effort,
      }
    : null;
};

const turnsFrom = (value: unknown): AssistantTurn[] =>
  (Array.isArray(value) ? value : [])
    .map(record)
    .filter(
      item =>
        typeof item.messageId === 'string' &&
        identifier.test(item.messageId) &&
        typeof item.text === 'string' &&
        item.text.length <= maxText,
    )
    .map(item => ({
      messageId: item.messageId as string,
      text: item.text as string,
    }))
    .slice(-maxTurns);

const conversationsFrom = (value: unknown): AssistantConversation[] =>
  (Array.isArray(value) ? value : [])
    .map(record)
    .filter(
      item =>
        typeof item.sessionId === 'string' &&
        identifier.test(item.sessionId) &&
        typeof item.title === 'string' &&
        item.title.length <= maxTitle &&
        typeof item.at === 'string' &&
        !Number.isNaN(Date.parse(item.at)),
    )
    .map(item => ({
      sessionId: item.sessionId as string,
      title: item.title as string,
      at: item.at as string,
    }))
    .slice(0, maxConversations);

function read(): Saved {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 2_000_000) return empty();
    const value = record(JSON.parse(raw));
    const saved = empty();
    if (typeof value.collapsed === 'boolean') saved.collapsed = value.collapsed;
    for (const [host, pick] of Object.entries(record(value.picks))) {
      const valid = pickFrom(pick);
      if (valid) saved.picks[host] = valid;
    }
    for (const [scope, sessionId] of Object.entries(record(value.sessions)))
      if (typeof sessionId === 'string' && identifier.test(sessionId))
        saved.sessions[scope] = sessionId;
    for (const [scope, list] of Object.entries(record(value.conversations)))
      saved.conversations[scope] = conversationsFrom(list);
    for (const [session, turns] of Object.entries(record(value.turns)))
      saved.turns[session] = turnsFrom(turns);
    return saved;
  } catch {
    return empty();
  }
}

function update(change: (saved: Saved) => void): void {
  try {
    const saved = read();
    change(saved);
    const sessions = Object.entries(saved.sessions).slice(-maxSessions);
    const conversations = Object.entries(saved.conversations).slice(
      -maxSessions,
    );
    const turns = Object.entries(saved.turns).slice(-maxSessions);
    localStorage.setItem(
      key,
      JSON.stringify({
        ...saved,
        sessions: Object.fromEntries(sessions),
        conversations: Object.fromEntries(
          conversations.map(([scope, items]) => [
            scope,
            items.slice(0, maxConversations),
          ]),
        ),
        turns: Object.fromEntries(
          turns.map(([session, items]) => [session, items.slice(-maxTurns)]),
        ),
      }),
    );
  } catch {
    return;
  }
}

export const conversationScope = (
  hostId: string,
  directory: string,
  workflowName: string | null,
  area = '',
) => JSON.stringify([hostId, directory, workflowName ?? '', area]);

export const readCollapsed = () => read().collapsed;

export const saveCollapsed = (collapsed: boolean) =>
  update(saved => {
    saved.collapsed = collapsed;
  });

export const readPick = (hostId: string) => read().picks[hostId] ?? null;

export const savePick = (hostId: string, pick: AssistantPick) =>
  update(saved => {
    saved.picks[hostId] = pick;
  });

export const readSessionId = (scope: string) => read().sessions[scope] ?? null;

export const saveSessionId = (scope: string, sessionId: string) =>
  update(saved => {
    delete saved.sessions[scope];
    saved.sessions[scope] = sessionId;
  });

export const clearSessionId = (scope: string) =>
  update(saved => {
    delete saved.sessions[scope];
  });

export const readConversations = (scope: string) =>
  read().conversations[scope] ?? [];

export const rememberConversation = (
  scope: string,
  conversation: AssistantConversation,
) =>
  update(saved => {
    const rest = (saved.conversations[scope] ?? []).filter(
      item => item.sessionId !== conversation.sessionId,
    );
    delete saved.conversations[scope];
    saved.conversations[scope] = [
      { ...conversation, title: conversation.title.slice(0, maxTitle) },
      ...rest,
    ].slice(0, maxConversations);
  });

export const readTurns = (sessionKey: string) => read().turns[sessionKey] ?? [];

export const saveTurn = (sessionKey: string, turn: AssistantTurn) =>
  update(saved => {
    const turns = saved.turns[sessionKey] ?? [];
    delete saved.turns[sessionKey];
    saved.turns[sessionKey] = [...turns, turn];
  });
