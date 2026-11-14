import { useMemo, useState } from 'react';
import type {
  DesktopSession,
  PipelineAssistantDocument,
  WorkspaceEvent,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { hostKey } from '@/shared/lib/host-key';
import {
  conversationScope,
  readSessionId,
  readTurns,
  saveSessionId,
  saveTurn,
  type AssistantPick,
  type AssistantTurn,
} from './assistant-storage';

export type AssistantProposal = Extract<
  WorkspaceEvent,
  { type: 'pipeline-assistant-proposal' }
>;

export type AssistantEntryStatus =
  | 'working'
  | 'checking'
  | 'replied'
  | 'proposal'
  | 'invalid'
  | 'failed'
  | 'unavailable';

export type AssistantEntry = {
  messageId: string;
  text: string;
  status: AssistantEntryStatus;
  reply: string;
  proposal: AssistantProposal | null;
};

type UseAssistantParams = {
  hostId: string;
  directory: string;
  pipelineName: string | null;
  document: PipelineAssistantDocument | null;
  selection: string[];
  sessions: DesktopSession[];
  proposals: Record<string, AssistantProposal>;
  pick: AssistantPick;
};

const documentLimit = 65_536;
const selectionLimit = 32;
const sentThisRun = new Set<string>();
const endedStates = new Set(['failed', 'stopped', 'interrupted']);

function entryFor(
  turn: AssistantTurn,
  session: DesktopSession | null,
  proposal: AssistantProposal | null,
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
  if (endedStates.has(reply.state)) return { ...base, status: 'failed' };
  return {
    ...base,
    status: sentThisRun.has(turn.messageId) ? 'checking' : 'replied',
  };
}

export function useAssistant({
  hostId,
  directory,
  pipelineName,
  document,
  selection,
  sessions,
  proposals,
  pick,
}: UseAssistantParams) {
  const scope = conversationScope(hostId, directory, pipelineName);
  const [stored, setStored] = useState(() => ({
    scope,
    sessionId: readSessionId(scope),
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
  const storedTurns = useMemo(
    () => (sessionKey ? readTurns(sessionKey) : []),
    [sessionKey],
  );
  const turns = turnsBySession[sessionKey] ?? storedTurns;
  const continuing =
    !!session &&
    session.provider === pick.provider &&
    session.model === pick.model &&
    (session.effort ?? '') === pick.effort;
  const entries = turns.map(turn =>
    entryFor(turn, session, proposals[hostKey(turn.messageId, hostId)] ?? null),
  );
  const send = async (text: string) => {
    const message = text.trim();
    if (!message || pending !== null) return false;
    setPending(message);
    setNotice(null);
    try {
      const turn = await window.nesvo.pipelines.assistantSend(hostId, {
        sessionId: continuing && session ? session.id : null,
        provider: pick.provider,
        model: pick.model,
        effort: pick.effort || null,
        text: message,
        context: {
          directory,
          pipelineName,
          document:
            document && document.text.length <= documentLimit ? document : null,
          selection: selection.slice(0, selectionLimit),
        },
      });
      const key = hostKey(turn.sessionId, hostId);
      const saved = { messageId: turn.messageId, text: message };
      sentThisRun.add(turn.messageId);
      saveSessionId(scope, turn.sessionId);
      saveTurn(key, saved);
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
  return {
    session,
    entries,
    pending,
    notice: notice?.scope === scope ? notice.text : '',
    newConversation: !!session && !continuing,
    send,
  };
}
