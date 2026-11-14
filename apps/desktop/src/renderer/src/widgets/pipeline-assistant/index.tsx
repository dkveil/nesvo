import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type {
  Computer,
  DesktopSession,
  PipelineAssistantDocument,
} from '@nesvo/contracts';
import {
  ArrowUp,
  ChevronDown,
  LoaderCircle,
  MessageSquareText,
  Sparkles,
} from 'lucide-react';
import { cn } from 'cn';
import {
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { ModelPicker } from '@/features/new-thread/model-picker';
import {
  modelEfforts,
  resolveEffort,
} from '@/features/new-thread/reasoning-effort';
import { MessageBody } from '@/widgets/conversation/message-body';
import { PanelAction } from '@/shared/ui/panel';
import { Textarea } from '@/shared/ui/textarea';
import {
  readCollapsed,
  readPick,
  saveCollapsed,
  savePick,
  type AssistantPick,
} from './assistant-storage';
import { ProposalCard, type ProposalDecision } from './proposal-card';
import {
  useAssistant,
  type AssistantEntry,
  type AssistantProposal,
} from './use-assistant';

export type { AssistantProposal } from './use-assistant';

type Props = {
  hostId: string;
  directory: string;
  pipelineName: string | null;
  document: PipelineAssistantDocument | null;
  selection: string[];
  statuses: ProviderStates;
  computers: Computer[];
  sessions: DesktopSession[];
  proposals: Record<string, AssistantProposal>;
  onRefreshProvider: (provider: Provider) => void;
  onApplied: () => void;
  onOpenSession: (sessionId: string) => void;
};

const textLimit = 8000;

function lastAuthor(sessions: DesktopSession[], hostId: string) {
  return (
    sessions.find(
      session => session.hostId === hostId && session.pipelineRunId !== null,
    )?.provider ?? null
  );
}

function resolvePick(
  saved: AssistantPick | null,
  statuses: ProviderStates,
  author: Provider | null,
): AssistantPick {
  const provider =
    saved?.provider ??
    (author ? providers.find(item => item !== author) : undefined) ??
    'Claude Code';
  const state = statuses[provider];
  const models = state.status?.models ?? [];
  const model =
    saved && models.some(option => option.id === saved.model)
      ? saved.model
      : (models[0]?.id ?? saved?.model ?? '');
  return {
    provider,
    model,
    effort: resolveEffort(
      modelEfforts(state, model),
      saved?.model === model ? saved.effort : '',
    ),
  };
}

function ShowReply({ reply }: { reply: string }) {
  const [open, setOpen] = useState(false);
  if (!reply) return null;
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="text-2xs text-muted-foreground underline-offset-2 outline-none enabled:hover:text-foreground enabled:hover:underline focus-visible:underline"
      >
        {open ? 'Hide reply' : 'Show reply'}
      </button>
      {open && (
        <MessageBody
          body={reply}
          className="max-h-60 overflow-auto text-xs leading-5"
        />
      )}
    </div>
  );
}

function AgentStatus({ children }: { children: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <LoaderCircle
        className="size-3 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      {children}
    </p>
  );
}

export default function PipelineAssistantDock({
  hostId,
  directory,
  pipelineName,
  document,
  selection,
  statuses,
  computers,
  sessions,
  proposals,
  onRefreshProvider,
  onApplied,
  onOpenSession,
}: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [savedPicks, setSavedPicks] = useState<
    Record<string, AssistantPick | null>
  >({});
  const [draft, setDraft] = useState('');
  const [decisions, setDecisions] = useState<Record<string, ProposalDecision>>(
    {},
  );
  const [seen, setSeen] = useState<Set<string>>(
    () =>
      new Set(
        Object.values(proposals).map(
          item => `${item.hostId}:${item.messageId}`,
        ),
      ),
  );
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const saved = useMemo(
    () =>
      hostId in savedPicks ? (savedPicks[hostId] ?? null) : readPick(hostId),
    [hostId, savedPicks],
  );
  const pick = resolvePick(saved, statuses, lastAuthor(sessions, hostId));
  const assistant = useAssistant({
    hostId,
    directory: directory.trim(),
    pipelineName,
    document,
    selection,
    sessions,
    proposals,
    pick,
  });
  const proposalKeys = assistant.entries
    .filter(entry => entry.status === 'proposal')
    .map(entry => `${hostId}:${entry.messageId}`);
  const unseen = proposalKeys.filter(key => !seen.has(key)).length;
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  const providerState = statuses[pick.provider];
  const providerReady =
    providerState.status?.status === 'ready' &&
    !providerState.loading &&
    !providerState.error;
  const blockedReason = !connected
    ? `${computer?.name ?? 'This computer'} is offline.`
    : !directory.trim()
      ? 'Choose a project folder to ask the assistant.'
      : !providerReady
        ? `${pick.provider} is not ready on ${computer?.name ?? 'this computer'}.`
        : !pick.model
          ? 'Choose a model.'
          : '';
  const lastEntry = assistant.entries.at(-1);
  useEffect(() => {
    if (collapsed) return;
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [
    collapsed,
    assistant.entries.length,
    lastEntry?.status,
    assistant.pending,
  ]);
  const toggle = (next: boolean) => {
    setCollapsed(next);
    saveCollapsed(next);
    setSeen(previous => new Set([...previous, ...proposalKeys]));
    if (!next) requestAnimationFrame(() => input.current?.focus());
  };
  const submit = async () => {
    if (blockedReason || assistant.pending !== null) return;
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    const sent = await assistant.send(text);
    if (!sent) setDraft(current => current || text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  const decide = (key: string, decision: ProposalDecision) =>
    setDecisions(previous => ({ ...previous, [key]: decision }));
  const renderEntry = (entry: AssistantEntry) => {
    const proposal = entry.proposal?.proposal ?? null;
    return (
      <li
        key={entry.messageId}
        data-assistant-turn={entry.messageId}
        data-assistant-status={entry.status}
        className="space-y-2"
      >
        <div className="flex justify-end">
          <MessageBody
            body={entry.text}
            className="max-w-[85%] rounded-xl bg-message-surface px-3 py-1.5 text-xs leading-5"
          />
        </div>
        {entry.status === 'working' && <AgentStatus>Working…</AgentStatus>}
        {entry.status === 'checking' && (
          <>
            <AgentStatus>Checking the answer…</AgentStatus>
            <ShowReply reply={entry.reply} />
          </>
        )}
        {entry.status === 'replied' && (
          <MessageBody
            body={entry.reply || 'No response text.'}
            className="text-xs leading-5"
          />
        )}
        {entry.status === 'unavailable' && (
          <p className="text-xs text-muted-foreground">
            This conversation is no longer available.
          </p>
        )}
        {entry.status === 'failed' && (
          <>
            <p className="text-xs text-muted-foreground">
              The assistant stopped before answering.
            </p>
            <ShowReply reply={entry.reply} />
          </>
        )}
        {entry.status === 'invalid' && (
          <>
            <p className="text-xs text-muted-foreground">
              The assistant returned no proposal.
            </p>
            <ShowReply reply={entry.reply} />
          </>
        )}
        {entry.status === 'proposal' && proposal && (
          <div className="space-y-2">
            {proposal.message && (
              <MessageBody
                body={proposal.message}
                className="text-xs leading-5"
              />
            )}
            {proposal.changes.map((change, index) => {
              const key = `${hostId}:${entry.messageId}:${index}`;
              return (
                <ProposalCard
                  key={key}
                  hostId={hostId}
                  directory={directory.trim()}
                  sessionId={entry.proposal?.sessionId ?? ''}
                  sessionDirectory={assistant.session?.directory ?? null}
                  change={change}
                  issues={
                    entry.proposal?.issues.find(item => item.index === index)
                      ?.issues ?? []
                  }
                  document={document}
                  decision={decisions[key] ?? null}
                  connected={connected}
                  onDecision={decision => decide(key, decision)}
                  onApplied={onApplied}
                />
              );
            })}
            {proposal.changes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                The proposal changes no files.
              </p>
            )}
          </div>
        )}
      </li>
    );
  };
  if (collapsed)
    return (
      <button
        type="button"
        aria-label={
          unseen > 0
            ? `Open assistant, ${unseen} new ${unseen === 1 ? 'proposal' : 'proposals'}`
            : 'Open assistant'
        }
        title="Assistant"
        onClick={() => toggle(false)}
        className={cn(
          'glass-popover relative flex size-10 items-center justify-center rounded-full border text-foreground outline-none',
          'transition-[background-color,scale] duration-150 ease-out enabled:hover:bg-accent enabled:active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Sparkles className="size-4" aria-hidden="true" />
        {unseen > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground tabular-nums"
          >
            {unseen}
          </span>
        )}
      </button>
    );
  return (
    <section
      role="region"
      aria-label="Assistant"
      className="glass-popover flex h-[520px] max-h-[calc(100vh-7rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border"
    >
      <header className="flex h-10 shrink-0 items-center gap-1 border-b pr-1.5 pl-3">
        <Sparkles
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="shrink-0 text-[13px] font-semibold">Assistant</h2>
        <div className="ml-auto flex min-w-0 items-center gap-0.5">
          <ModelPicker
            provider={pick.provider}
            model={pick.model}
            effort={pick.effort}
            statuses={statuses}
            disabled={!connected || assistant.pending !== null}
            onChange={(provider, model, effort) => {
              const next = { provider, model, effort };
              savePick(hostId, next);
              setSavedPicks(previous => ({ ...previous, [hostId]: next }));
            }}
            onRefreshProvider={onRefreshProvider}
          />
          <PanelAction
            aria-label="Open session"
            title="Open the full conversation"
            disabled={!assistant.session}
            onClick={() =>
              assistant.session && onOpenSession(assistant.session.id)
            }
          >
            <MessageSquareText />
          </PanelAction>
          <PanelAction
            aria-label="Collapse assistant"
            onClick={() => toggle(true)}
          >
            <ChevronDown />
          </PanelAction>
        </div>
      </header>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {assistant.entries.length === 0 && assistant.pending === null ? (
          <p className="px-1 py-6 text-center text-xs leading-5 text-muted-foreground">
            Describe a change to{' '}
            {pipelineName ? pipelineName : 'your pipelines'}. Proposals change
            nothing until you apply them.
          </p>
        ) : (
          <ol aria-label="Assistant messages" className="space-y-4">
            {assistant.entries.map(renderEntry)}
            {assistant.pending !== null && (
              <li className="space-y-2" data-assistant-status="sending">
                <div className="flex justify-end">
                  <MessageBody
                    body={assistant.pending}
                    className="max-w-[85%] rounded-xl bg-message-surface px-3 py-1.5 text-xs leading-5 opacity-70"
                  />
                </div>
                <AgentStatus>Sending…</AgentStatus>
              </li>
            )}
          </ol>
        )}
      </div>
      <form
        className="shrink-0 space-y-1.5 border-t p-2"
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        {assistant.notice && (
          <p
            role="alert"
            className="px-1 text-2xs leading-4 text-destructive [overflow-wrap:anywhere]"
          >
            {assistant.notice}
          </p>
        )}
        <div className="rounded-lg border bg-background/40 px-2 pt-1.5 pb-1 transition-colors duration-150 focus-within:border-input">
          <label htmlFor="pipeline-assistant-input" className="sr-only">
            Message the assistant
          </label>
          <Textarea
            ref={input}
            id="pipeline-assistant-input"
            value={draft}
            maxLength={textLimit}
            placeholder="Ask for a step or a pipeline change"
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            className="max-h-32 min-h-9 resize-none rounded-none border-0 bg-transparent px-1 py-0.5 text-xs leading-5 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 md:text-xs dark:bg-transparent"
          />
          <div className="flex items-center justify-between gap-2">
            <span
              role="status"
              className="min-w-0 truncate text-[11px] leading-6 text-muted-foreground"
            >
              {blockedReason ||
                (assistant.newConversation
                  ? 'Starts a new conversation with this model.'
                  : '')}
            </span>
            <button
              type="submit"
              aria-label="Send to assistant"
              disabled={
                !!blockedReason || assistant.pending !== null || !draft.trim()
              }
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none',
                'transition-[background-color,scale] duration-150 ease-out enabled:hover:bg-primary/90 enabled:active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              <ArrowUp className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
