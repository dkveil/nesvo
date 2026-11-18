import type { PromptSkill } from '@nesvo/contracts';
import { useEffect, useMemo, useState } from 'react';
import type {
  AssistantChange,
  AssistantChangeRefusal,
  DesktopSession,
  WorkspaceEvent,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { hostKey } from '@/shared/lib/host-key';
import { assistantArea, type AssistantContext } from './assistant-context';
import {
  clearSessionId,
  conversationScope,
  readConversations,
  readSessionId,
  readTurns,
  rememberConversation,
  saveSessionId,
  saveTurn,
  type AssistantConversation,
  type AssistantPick,
  type AssistantTurn,
} from './assistant-storage';

export type AssistantProposal = Extract<
  WorkspaceEvent,
  { type: 'workflow-assistant-proposal' }
>;

export type AssistantEntryStatus =
  | 'working'
  | 'checking'
  | 'replied'
  | 'proposal'
  | 'invalid'
  | 'failed'
  | 'stopped'
  | 'unavailable';

export type AssistantEntry = {
  messageId: string;
  text: string;
  status: AssistantEntryStatus;
  reply: string;
  proposal: AssistantProposal | null;
  changes: AssistantChange[];
  refusals: AssistantChangeRefusal[];
};

type UseAssistantParams = {
  hostId: string;
  directory: string;
  context: AssistantContext;
  sessions: DesktopSession[];
  proposals: Record<string, AssistantProposal>;
  changes: AssistantChange[];
  refusals: AssistantChangeRefusal[];
  pick: AssistantPick;
  loadSession: (sessionKey: string) => void;
};

const assistantSendView = {
  workflows: 'workflows-list',
  automations: 'automations-list',
  editor: 'editor',
} as const;
const documentLimit = 65_536;
const selectionLimit = 32;
const sentThisRun = new Set<string>();
const endedStates = new Set(['failed', 'interrupted']);

function entryFor(
  turn: AssistantTurn,
  session: DesktopSession | null,
  proposal: AssistantProposal | null,
  changes: AssistantChange[],
  refusals: AssistantChangeRefusal[],
): AssistantEntry {
  const operator = session?.messages.find(item => item.id === turn.messageId);
  const reply = operator
    ? session?.messages.findLast(
        item => item.author === 'agent' && item.runId === operator.runId,
      )
    : undefined;
  const base = {
    messageId: turn.messageId,
    text: turn.text,
    reply: reply?.body ?? '',
    proposal,
    changes,
    refusals,
  };
  if (proposal)
    return {
      ...base,
      status: proposal.status === 'ok' ? 'proposal' : 'invalid',
    };
  if (!session && !sentThisRun.has(turn.messageId))
    return { ...base, status: 'unavailable' };
  if (!reply || reply.state === 'running' || reply.state === 'stopping')
    return { ...base, status: 'working' };
  if (reply.state === 'stopped') return { ...base, status: 'stopped' };
  if (endedStates.has(reply.state)) return { ...base, status: 'failed' };
  return {
    ...base,
    status:
      sentThisRun.has(turn.messageId) && changes.length === 0
        ? 'checking'
        : 'replied',
  };
}

export function useAssistant({
  hostId,
  directory,
  context,
  sessions,
  proposals,
  changes,
  refusals,
  pick,
  loadSession,
}: UseAssistantParams) {
  const scope = conversationScope(
    hostId,
    directory,
    context.workflowName,
    assistantArea(context),
  );
  const [stored, setStored] = useState(() => ({
    scope,
    sessionId: readSessionId(scope),
  }));
  const [conversationsState, setConversationsState] = useState(() => ({
    scope,
    list: readConversations(scope),
  }));
  const [turnsBySession, setTurnsBySession] = useState<
    Record<string, AssistantTurn[]>
  >({});
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ scope: string; text: string } | null>(
    null,
  );
  const scopeSessionId = useMemo(() => readSessionId(scope), [scope]);
  const sessionId = stored.scope === scope ? stored.sessionId : scopeSessionId;
  const session =
    sessions.find(item => item.id === sessionId && item.hostId === hostId) ??
    null;
  const sessionKey = sessionId ? hostKey(sessionId, hostId) : '';
  const sessionLoaded = !!session;
  useEffect(() => {
    if (sessionKey) loadSession(sessionKey);
  }, [loadSession, sessionKey, sessionLoaded]);
  const storedTurns = useMemo(
    () => (sessionKey ? readTurns(sessionKey) : []),
    [sessionKey],
  );
  const listed: AssistantConversation[] =
    conversationsState.scope === scope
      ? conversationsState.list
      : readConversations(scope);
  const conversations = listed.filter(
    item =>
      item.sessionId === sessionId ||
      readTurns(hostKey(item.sessionId, hostId)).length > 0,
  );
  const turns = turnsBySession[sessionKey] ?? storedTurns;
  const continuing =
    !!session &&
    session.provider === pick.provider &&
    session.model === pick.model &&
    (session.effort ?? '') === pick.effort;
  const ownChanges = sessionId
    ? changes.filter(change => change.conversationId === sessionId)
    : [];
  const ownRefusals = sessionId
    ? refusals.filter(refusal => refusal.conversationId === sessionId)
    : [];
  const entries = turns.map(turn =>
    entryFor(
      turn,
      session,
      proposals[hostKey(turn.messageId, hostId)] ?? null,
      ownChanges.filter(change => change.messageId === turn.messageId),
      ownRefusals.filter(refusal => refusal.messageId === turn.messageId),
    ),
  );
  const running =
    !!session &&
    (session.status === 'running' || session.status === 'stopping');
  const send = async (text: string, promptSkill?: PromptSkill) => {
    const message = text.trim();
    if (!message || pending !== null) return false;
    setPending(message);
    setNotice(null);
    try {
      const turn = await window.nesvo.workflows.assistantSend(hostId, {
        sessionId: continuing && session ? session.id : null,
        provider: pick.provider,
        model: pick.model,
        effort: pick.effort || null,
        text: message,
        ...(promptSkill ? { promptSkill } : {}),
        context: {
          view: assistantSendView[context.view],
          directory,
          workflowName: context.workflowName,
          document:
            context.document && context.document.text.length <= documentLimit
              ? context.document
              : null,
          selection: context.selection.slice(0, selectionLimit),
        },
      });
      const key = hostKey(turn.sessionId, hostId);
      const saved = { messageId: turn.messageId, text: message };
      sentThisRun.add(turn.messageId);
      saveSessionId(scope, turn.sessionId);
      saveTurn(key, saved);
      rememberConversation(scope, {
        sessionId: turn.sessionId,
        title:
          conversations.find(item => item.sessionId === turn.sessionId)
            ?.title ?? message,
        at: new Date().toISOString(),
      });
      setConversationsState({ scope, list: readConversations(scope) });
      setStored({ scope, sessionId: turn.sessionId });
      setTurnsBySession(previous => ({
        ...previous,
        [key]: [
          ...(previous[key] ?? readTurns(key)).filter(
            item => item.messageId !== saved.messageId,
          ),
          saved,
        ],
      }));
      return true;
    } catch (failure) {
      setNotice({ scope, text: errorDetail(failure) });
      return false;
    } finally {
      setPending(null);
    }
  };
  const startNew = () => {
    clearSessionId(scope);
    setStored({ scope, sessionId: null });
    setNotice(null);
  };
  const switchTo = (target: string) => {
    saveSessionId(scope, target);
    setStored({ scope, sessionId: target });
    setNotice(null);
  };
  return {
    session,
    sessionId,
    entries,
    pending,
    running,
    notice: notice?.scope === scope ? notice.text : '',
    newConversation: !!session && !continuing,
    conversations,
    changes: ownChanges,
    send,
    startNew,
    switchTo,
  };
}
