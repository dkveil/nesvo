import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  AssistantChange,
  AssistantChangeRefusal,
  AssistantUndoResult,
  Computer,
  DesktopSession,
} from '@nesvo/contracts';
import {
  ArrowUp,
  ChevronDown,
  History,
  LoaderCircle,
  MessageSquareText,
  Sparkles,
  Square,
  SquarePen,
} from 'lucide-react';
import { cn } from 'cn';
import {
  errorDetail,
  ProviderGlyph,
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
import { formatRelativeTime } from '@/shared/lib/relative-time';
import { useNow } from '@/shared/lib/use-now';
import { Button } from '@/shared/ui/button';
import { PanelAction } from '@/shared/ui/panel';
import { Textarea } from '@/shared/ui/textarea';
import {
  assistantIntro,
  assistantSubject,
  assistantSuggestions,
  type AssistantContext,
} from './assistant-context';
import {
  clampSize,
  readCollapsed,
  readPick,
  readSize,
  saveCollapsed,
  savePick,
  saveSize,
  type AssistantPick,
  type AssistantSize,
} from './assistant-storage';
import { ChangeCard, RefusalCard } from './change-card';
import { ProposalCard, type ProposalDecision } from './proposal-card';
import {
  useAssistant,
  type AssistantEntry,
  type AssistantProposal,
} from './use-assistant';

export type { AssistantProposal } from './use-assistant';
export type { AssistantContext, AssistantView } from './assistant-context';

type Props = {
  hostId: string;
  directory: string;
  context: AssistantContext;
  statuses: ProviderStates;
  computers: Computer[];
  sessions: DesktopSession[];
  proposals: Record<string, AssistantProposal>;
  changes: AssistantChange[];
  refusals: AssistantChangeRefusal[];
  onRefreshProvider: (provider: Provider) => void;
  onApplied: () => void;
  onOpenSession: (sessionId: string) => void;
  onStop: (sessionId: string) => Promise<void>;
  onUndo: (change: AssistantChange) => Promise<AssistantUndoResult>;
  onOpenChange?: (change: AssistantChange) => void;
  canOpenChange?: (change: AssistantChange) => boolean;
  onLoadChanges?: (conversationId: string) => Promise<void>;
};

const textLimit = 8000;

function lastAuthor(sessions: DesktopSession[], hostId: string) {
  return (
    sessions.find(
      session => session.hostId === hostId && session.workflowRunId !== null,
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

function Working({ children }: { children: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 text-2xs text-muted-foreground"
    >
      <LoaderCircle
        className="size-3 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      {children}
    </p>
  );
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

export default function WorkflowAssistantDock({
  hostId,
  directory,
  context,
  statuses,
  computers,
  sessions,
  proposals,
  changes,
  refusals,
  onRefreshProvider,
  onApplied,
  onOpenSession,
  onStop,
  onUndo,
  onOpenChange,
  canOpenChange,
  onLoadChanges,
}: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [size, setSize] = useState<AssistantSize>(readSize);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedPicks, setSavedPicks] = useState<
    Record<string, AssistantPick | null>
  >({});
  const [draft, setDraft] = useState('');
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');
  const [decisions, setDecisions] = useState<Record<string, ProposalDecision>>(
    {},
  );
  const [seen, setSeen] = useState<Set<string>>(
    () =>
      new Set([
        ...Object.values(proposals).map(
          item => `${item.hostId}:${item.messageId}`,
        ),
        ...changes.map(item => item.changeId),
      ]),
  );
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);
  const now = useNow(30_000);
  const saved = useMemo(
    () =>
      hostId in savedPicks ? (savedPicks[hostId] ?? null) : readPick(hostId),
    [hostId, savedPicks],
  );
  const pick = resolvePick(saved, statuses, lastAuthor(sessions, hostId));
  const assistant = useAssistant({
    hostId,
    directory: directory.trim(),
    context,
    sessions,
    proposals,
    changes,
    refusals,
    pick,
  });
  const proposalKeys = assistant.entries
    .filter(entry => entry.status === 'proposal')
    .map(entry => `${hostId}:${entry.messageId}`);
  const changeKeys = assistant.changes.map(change => change.changeId);
  const unseen = [...proposalKeys, ...changeKeys].filter(
    key => !seen.has(key),
  ).length;
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
      ? context.view === 'automations'
        ? 'Choose a project folder in Workflows first; automations are created there.'
        : 'Choose a project folder to ask the assistant.'
      : !providerReady
        ? `${pick.provider} is not ready on ${computer?.name ?? 'this computer'}.`
        : !pick.model
          ? 'Choose a model.'
          : '';
  const lastEntry = assistant.entries.at(-1);
  const appliedCount = assistant.changes.filter(
    change => change.status === 'applied',
  ).length;
  const lastChangeId = assistant.changes.at(-1)?.changeId ?? '';
  const callbacks = useRef({ onApplied, onLoadChanges });
  useEffect(() => {
    callbacks.current = { onApplied, onLoadChanges };
  });
  const seenChangeId = useRef(lastChangeId);
  useEffect(() => {
    if (!lastChangeId || seenChangeId.current === lastChangeId) return;
    seenChangeId.current = lastChangeId;
    callbacks.current.onApplied();
  }, [lastChangeId]);
  const conversationId = assistant.sessionId;
  useEffect(() => {
    if (!conversationId) return;
    void callbacks.current.onLoadChanges?.(conversationId);
  }, [conversationId, hostId]);
  useEffect(() => {
    if (collapsed || historyOpen) return;
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [
    collapsed,
    historyOpen,
    assistant.entries.length,
    lastEntry?.status,
    lastEntry?.reply,
    assistant.pending,
    appliedCount,
  ]);
  const toggle = (next: boolean) => {
    setCollapsed(next);
    saveCollapsed(next);
    setSeen(previous => new Set([...previous, ...proposalKeys, ...changeKeys]));
    if (!next) requestAnimationFrame(() => input.current?.focus());
  };
  const submit = async () => {
    if (blockedReason || assistant.pending !== null || assistant.running)
      return;
    const text = draft;
    if (!text.trim()) return;
    setDraft('');
    const sent = await assistant.send(text);
    if (!sent) setDraft(current => current || text);
  };
  const stop = async () => {
    if (!assistant.session) return;
    setStopping(true);
    setStopError('');
    try {
      await onStop(assistant.session.id);
    } catch (error) {
      setStopError(errorDetail(error));
    } finally {
      setStopping(false);
    }
  };
  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  const onPanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target.closest('[role="dialog"], [data-radix-popper-content-wrapper]'))
      return;
    if (historyOpen) {
      event.preventDefault();
      setHistoryOpen(false);
      return;
    }
    event.preventDefault();
    toggle(true);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>('[data-assistant-toggle]')
        ?.focus(),
    );
  };
  const resizeStart = useRef<{
    pointer: { x: number; y: number };
    size: AssistantSize;
  } | null>(null);
  const onResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    resizeStart.current = {
      pointer: { x: event.clientX, y: event.clientY },
      size,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    setSize(
      clampSize({
        width: start.size.width + (start.pointer.x - event.clientX),
        height: start.size.height + (start.pointer.y - event.clientY),
      }),
    );
  };
  const onResizePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!resizeStart.current) return;
    resizeStart.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    saveSize(size);
  };
  const onResizeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = 24;
    const delta = {
      ArrowLeft: { width: step, height: 0 },
      ArrowRight: { width: -step, height: 0 },
      ArrowUp: { width: 0, height: step },
      ArrowDown: { width: 0, height: -step },
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    const next = clampSize({
      width: size.width + delta.width,
      height: size.height + delta.height,
    });
    setSize(next);
    saveSize(next);
  };
  const decide = (key: string, decision: ProposalDecision) =>
    setDecisions(previous => ({ ...previous, [key]: decision }));
  const renderEntry = (entry: AssistantEntry) => {
    const proposal = entry.proposal?.proposal ?? null;
    const streaming = entry.status === 'working' && entry.reply.trim() !== '';
    return (
      <li
        key={entry.messageId}
        data-assistant-turn={entry.messageId}
        data-assistant-status={entry.status}
        className="space-y-2.5"
      >
        <div className="flex justify-end">
          <MessageBody
            body={entry.text}
            className="max-w-[85%] rounded-2xl rounded-br-md bg-message-surface px-3 py-1.5 text-xs leading-5"
          />
        </div>
        <div className="flex gap-2.5">
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-muted-foreground"
          >
            <ProviderGlyph provider={pick.provider} className="size-3" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            {entry.status === 'working' && !streaming && (
              <Working>Working…</Working>
            )}
            {streaming && (
              <>
                <MessageBody body={entry.reply} className="text-xs leading-5" />
                <Working>Still working…</Working>
              </>
            )}
            {entry.status === 'checking' && (
              <>
                <Working>Checking the answer…</Working>
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
            {entry.status === 'stopped' && (
              <>
                <p className="text-xs text-muted-foreground">Stopped.</p>
                <ShowReply reply={entry.reply} />
              </>
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
                  The assistant answered without a change it could apply.
                </p>
                <ShowReply reply={entry.reply} />
              </>
            )}
            {entry.changes.length > 0 && (
              <ol
                aria-label="Changes made by the assistant"
                className="space-y-1.5"
              >
                {entry.changes.map(change => (
                  <li key={change.changeId}>
                    <ChangeCard
                      change={change}
                      onUndo={onUndo}
                      onOpen={
                        onOpenChange &&
                        change.op !== 'delete' &&
                        (canOpenChange?.(change) ?? true)
                          ? onOpenChange
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ol>
            )}
            {entry.refusals.map((refusal, index) => (
              <RefusalCard key={`${refusal.at}-${index}`} refusal={refusal} />
            ))}
            {entry.status === 'proposal' && proposal && (
              <div className="space-y-2">
                {proposal.message && (
                  <MessageBody
                    body={proposal.message}
                    className="text-xs leading-5"
                  />
                )}
                {proposal.changes.map((change, index) => {
                  const key = `${entry.messageId}:${index}`;
                  return (
                    <ProposalCard
                      key={key}
                      hostId={hostId}
                      directory={directory}
                      sessionId={entry.proposal?.sessionId ?? ''}
                      sessionDirectory={assistant.session?.directory ?? null}
                      change={change}
                      issues={
                        entry.proposal?.issues.find(
                          item => item.index === index,
                        )?.issues ?? []
                      }
                      document={
                        context.document?.name === change.name &&
                        context.document.kind === change.kind
                          ? context.document
                          : null
                      }
                      decision={decisions[key] ?? null}
                      connected={connected}
                      onDecision={decision => decide(key, decision)}
                      onApplied={onApplied}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </li>
    );
  };
  if (collapsed)
    return (
      <button
        type="button"
        data-assistant-toggle
        aria-label={
          unseen > 0
            ? `Open assistant, ${unseen} new ${unseen === 1 ? 'update' : 'updates'}`
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
        {assistant.running && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -left-0.5 size-2.5 rounded-full bg-info-foreground motion-safe:animate-pulse"
          />
        )}
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
  const subject = assistantSubject(context);
  return (
    <section
      ref={panel}
      role="region"
      aria-label="Assistant"
      data-assistant-dock
      onKeyDown={onPanelKeyDown}
      style={{ width: size.width, height: size.height }}
      className="glass-popover relative flex max-h-[calc(100vh-7rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border"
    >
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3.5">
        <Sparkles
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="shrink-0 text-[13px] font-semibold">Assistant</h2>
        <span
          className="min-w-0 truncate rounded-full border px-1.5 text-2xs leading-4 text-muted-foreground"
          title={subject}
        >
          {subject}
        </span>
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-0.5">
          <PanelAction
            aria-label="New chat"
            title="Start a new conversation"
            disabled={!assistant.sessionId || assistant.pending !== null}
            onClick={() => {
              assistant.startNew();
              setHistoryOpen(false);
              requestAnimationFrame(() => input.current?.focus());
            }}
          >
            <SquarePen />
          </PanelAction>
          <PanelAction
            aria-label="Conversation history"
            aria-pressed={historyOpen}
            title="Earlier conversations"
            disabled={assistant.conversations.length === 0}
            onClick={() => setHistoryOpen(value => !value)}
          >
            <History />
          </PanelAction>
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
            title="Collapse (Esc)"
            onClick={() => toggle(true)}
          >
            <ChevronDown />
          </PanelAction>
        </div>
      </header>
      <button
        type="button"
        aria-label="Resize assistant"
        title="Drag to resize. Arrow keys resize too."
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
        onKeyDown={onResizeKeyDown}
        className="absolute top-0 left-0 z-10 size-4 cursor-nwse-resize rounded-tl-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {historyOpen ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <h3 className="px-2 pt-1 pb-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
            Conversations
          </h3>
          <ol aria-label="Earlier conversations" className="space-y-px">
            {assistant.conversations.map(conversation => {
              const active = conversation.sessionId === assistant.sessionId;
              return (
                <li key={conversation.sessionId}>
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    data-assistant-conversation={conversation.sessionId}
                    onClick={() => {
                      assistant.switchTo(conversation.sessionId);
                      setHistoryOpen(false);
                      requestAnimationFrame(() => input.current?.focus());
                    }}
                    className={cn(
                      'flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
                      active && 'bg-highlight',
                    )}
                  >
                    <MessageSquareText
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs">
                      {conversation.title}
                    </span>
                    <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                      {formatRelativeTime(conversation.at, now)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ) : (
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {assistant.entries.length === 0 && assistant.pending === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
              <span className="flex size-10 items-center justify-center rounded-xl border bg-card text-muted-foreground">
                <Sparkles className="size-4.5" aria-hidden="true" />
              </span>
              <div className="space-y-1">
                <h3 className="text-[13px] font-semibold">Ask the assistant</h3>
                <p className="max-w-xs text-2xs leading-4 text-muted-foreground">
                  {assistantIntro(context)}
                </p>
              </div>
              <ul
                aria-label="Suggested prompts"
                className="flex w-full max-w-xs flex-col gap-1"
              >
                {assistantSuggestions(context).map(suggestion => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      data-assistant-suggestion
                      onClick={() => {
                        setDraft(suggestion);
                        input.current?.focus();
                      }}
                      className="w-full rounded-lg border px-2.5 py-1.5 text-left text-xs leading-4 text-muted-foreground transition-colors duration-100 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ol aria-label="Assistant messages" className="space-y-4">
              {assistant.entries.map(renderEntry)}
              {assistant.pending !== null && (
                <li className="space-y-2" data-assistant-status="sending">
                  <div className="flex justify-end">
                    <MessageBody
                      body={assistant.pending}
                      className="max-w-[85%] rounded-2xl rounded-br-md bg-message-surface px-3 py-1.5 text-xs leading-5 opacity-70"
                    />
                  </div>
                  <Working>Sending…</Working>
                </li>
              )}
            </ol>
          )}
        </div>
      )}
      <form
        className="shrink-0 space-y-1.5 p-2 pt-0"
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        {(assistant.notice || stopError) && (
          <p
            role="alert"
            className="px-1 text-2xs leading-4 text-destructive [overflow-wrap:anywhere]"
          >
            {assistant.notice || stopError}
          </p>
        )}
        <div className="glass-composer rounded-2xl border px-3 pt-2.5 pb-2 transition-colors duration-150 focus-within:border-input">
          <label htmlFor="workflow-assistant-input" className="sr-only">
            Message the assistant
          </label>
          <Textarea
            variant="ghost"
            size="lg"
            ref={input}
            id="workflow-assistant-input"
            value={draft}
            maxLength={textLimit}
            placeholder={
              context.view === 'automations'
                ? 'Describe what to run and when'
                : 'Ask for a step or a workflow change'
            }
            disabled={!!blockedReason && !draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            className="max-h-40 min-h-10 resize-none rounded-none border-0 bg-transparent px-1 py-0 text-[13px] leading-5 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 md:text-[13px] dark:bg-transparent"
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="flex min-w-0 items-center gap-1.5">
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
              <span
                role="status"
                className="min-w-0 truncate text-[11px] leading-7 text-muted-foreground"
              >
                {blockedReason ||
                  (assistant.newConversation
                    ? 'Starts a new conversation with this model.'
                    : assistant.running
                      ? 'Working…'
                      : '')}
              </span>
            </div>
            {assistant.running ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-7 shrink-0 rounded-full px-2.5"
                disabled={stopping || !connected}
                aria-label="Stop the assistant"
                title="Stop the assistant"
                onClick={() => void stop()}
              >
                <Square className="fill-current" />
                {stopping ? 'Stopping…' : 'Stop'}
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-sm"
                aria-label="Send to assistant"
                title="Send (Enter). Shift+Enter adds a line."
                disabled={
                  !!blockedReason || assistant.pending !== null || !draft.trim()
                }
                className="size-7 shrink-0 rounded-full disabled:bg-send-idle disabled:text-send-idle-foreground disabled:opacity-100 [&_svg]:size-4"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
