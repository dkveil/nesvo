import type { PromptSkill } from '@nesvo/contracts';
import { createPortal } from 'react-dom';
import { PromptTextarea } from '@/features/select-skill/prompt-textarea';
import { pendingSkillQuery } from '@/features/select-skill/skill-command';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type {
  AssistantChange,
  AssistantChangeRefusal,
  AssistantUndoResult,
  Computer,
  DesktopSession,
} from '@nesvo/contracts';
import {
  History,
  MessageSquareText,
  Sparkles,
  Square,
  SquarePen,
} from 'lucide-react';
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
import { CountBadge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Composer, ComposerSend, ComposerToolbar } from '@/shared/ui/composer';
import { EmptyState } from '@/shared/ui/empty-state';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { PanelBody } from '@/shared/ui/panel';
import {
  SidePanel,
  SidePanelHeader,
  SidePanelFooter,
} from '@/shared/ui/side-panel';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  assistantIntro,
  assistantSubject,
  assistantSuggestions,
  type AssistantContext,
} from './assistant-context';
import {
  readCollapsed,
  readPick,
  saveCollapsed,
  savePick,
  type AssistantPick,
} from './assistant-storage';
import { ChangeCard, RefusalCard } from './change-card';
import { GateAutonomy } from '@/features/workflow-gate-decision/gate-autonomy';
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
  drawerHost: HTMLElement | null;
  blocked?: boolean;
  open?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
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
  onLoadSession: (sessionKey: string) => void;
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
  return <StatusMessage tone="loading">{children}</StatusMessage>;
}

function ShowReply({ reply }: { reply: string }) {
  const [open, setOpen] = useState(false);
  if (!reply) return null;
  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="-ml-2 text-muted-foreground"
      >
        {open ? 'Hide reply' : 'Show reply'}
      </Button>
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
  drawerHost,
  blocked = false,
  open,
  onDrawerOpenChange,
  statuses,
  computers,
  sessions,
  proposals,
  changes,
  refusals,
  onRefreshProvider,
  onApplied,
  onOpenSession,
  onLoadSession,
  onStop,
  onUndo,
  onOpenChange,
  canOpenChange,
  onLoadChanges,
}: Props) {
  const [storedCollapsed, setCollapsed] = useState(readCollapsed);
  const collapsed = blocked || (open === undefined ? storedCollapsed : !open);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedPicks, setSavedPicks] = useState<
    Record<string, AssistantPick | null>
  >({});
  const [draft, setDraft] = useState('');
  const [skill, setSkill] = useState<PromptSkill>();
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
  const toggleButton = useRef<HTMLButtonElement>(null);
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
    loadSession: onLoadSession,
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
    onDrawerOpenChange?.(!next);
    setSeen(previous => new Set([...previous, ...proposalKeys, ...changeKeys]));
    if (!next) requestAnimationFrame(() => input.current?.focus());
  };
  const submit = async () => {
    if (blockedReason || assistant.pending !== null || assistant.running)
      return;
    const text = draft;
    if (!text.trim() || pendingSkillQuery(text)) return;
    setDraft('');
    const sent = await assistant.send(text, skill);
    if (sent) setSkill(undefined);
    else setDraft(current => current || text);
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
    requestAnimationFrame(() => toggleButton.current?.focus());
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
            className="max-w-[85%] rounded-composer rounded-br-control bg-message-surface px-3 py-1.5 text-xs leading-5"
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
            {entry.status === 'replied' && entry.refusals.length > 0 && (
              <ShowReply reply={entry.reply} />
            )}
            {entry.status === 'replied' && entry.refusals.length === 0 && (
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
                {entry.refusals.length > 0 ? (
                  <ShowReply reply={proposal.message || entry.reply} />
                ) : (
                  proposal.message && (
                    <MessageBody
                      body={proposal.message}
                      className="text-xs leading-5"
                    />
                  )
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
  if (blocked || !drawerHost) return null;
  if (collapsed)
    return (
      <IconButton
        size={40}
        shape="round"
        data-assistant-toggle
        ref={toggleButton}
        label={
          unseen > 0
            ? `Open assistant, ${unseen} new ${unseen === 1 ? 'update' : 'updates'}`
            : 'Open assistant'
        }
        tooltipSide="left"
        onClick={() => toggle(false)}
        className="glass-popover relative border text-foreground"
      >
        <Sparkles aria-hidden="true" />
        {assistant.running && (
          <StatusDot
            tone="info"
            size="md"
            pulse
            className="absolute -top-0.5 -left-0.5"
          />
        )}
        {unseen > 0 && (
          <CountBadge
            aria-hidden="true"
            count={unseen}
            className="absolute -top-1 -right-1 bg-primary text-primary-foreground"
          />
        )}
      </IconButton>
    );
  const close = () => {
    toggle(true);
    requestAnimationFrame(() => toggleButton.current?.focus());
  };
  return createPortal(
    <SidePanel
      kind="assistant"
      resizeLabel="Resize assistant"
      aria-label="Assistant"
      data-assistant-dock
      onKeyDown={onPanelKeyDown}
    >
      <SidePanelHeader
        titleBar={false}
        icon={Sparkles}
        title="Assistant"
        meta={assistantSubject(context)}
        closeLabel="Close assistant"
        onClose={close}
      >
        <IconButton
          label="New chat"
          disabled={!assistant.sessionId || assistant.pending !== null}
          onClick={() => {
            assistant.startNew();
            setHistoryOpen(false);
            requestAnimationFrame(() => input.current?.focus());
          }}
        >
          <SquarePen />
        </IconButton>
        <IconButton
          label="Conversation history"
          pressed={historyOpen}
          disabled={assistant.conversations.length === 0}
          onClick={() => setHistoryOpen(value => !value)}
        >
          <History />
        </IconButton>
        <IconButton
          label="Open session"
          disabled={!assistant.session}
          onClick={() =>
            assistant.session && onOpenSession(assistant.session.id)
          }
        >
          <MessageSquareText />
        </IconButton>
      </SidePanelHeader>
      {historyOpen ? (
        <PanelBody className="p-3 overscroll-contain">
          <SectionLabel>Conversations</SectionLabel>
          <ol aria-label="Earlier conversations" className="space-y-px">
            {assistant.conversations.map(conversation => (
              <li key={conversation.sessionId}>
                <ListRow
                  selected={conversation.sessionId === assistant.sessionId}
                  leading={<MessageSquareText aria-hidden="true" />}
                  title={conversation.title}
                  trailing={formatRelativeTime(conversation.at, now)}
                  onClick={() => {
                    assistant.switchTo(conversation.sessionId);
                    setHistoryOpen(false);
                    requestAnimationFrame(() => input.current?.focus());
                  }}
                  data-assistant-conversation={conversation.sessionId}
                />
              </li>
            ))}
          </ol>
        </PanelBody>
      ) : (
        <PanelBody ref={list} className="overscroll-contain p-3">
          {context.humanGate && context.workflowName && (
            <GateAutonomy
              key={`${context.workflowName}/${context.humanGate}`}
              hostId={hostId}
              directory={directory}
              workflow={context.workflowName}
              gate={context.humanGate}
            />
          )}
          {assistant.entries.length === 0 && assistant.pending === null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <EmptyState
                size="sm"
                icon={Sparkles}
                title="Ask the assistant"
                description={assistantIntro(context)}
                className="py-0"
              />
              <ul
                aria-label="Suggested prompts"
                className="flex w-full max-w-sm flex-col gap-1"
              >
                {assistantSuggestions(context).map(suggestion => (
                  <li key={suggestion}>
                    <Button
                      type="button"
                      variant="outline"
                      data-assistant-suggestion
                      onClick={() => {
                        setDraft(suggestion);
                        input.current?.focus();
                      }}
                      className="w-full justify-start font-normal text-muted-foreground"
                    >
                      <span className="truncate">{suggestion}</span>
                    </Button>
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
                      className="max-w-[85%] rounded-composer rounded-br-control bg-message-surface px-3 py-1.5 text-xs leading-5 opacity-70"
                    />
                  </div>
                  <Working>Sending…</Working>
                </li>
              )}
            </ol>
          )}
        </PanelBody>
      )}
      <SidePanelFooter
        label="Assistant actions"
        className="h-auto min-h-10 items-stretch py-2"
      >
        <form
          className="min-w-0 flex-1 space-y-1.5"
          onSubmit={event => {
            event.preventDefault();
            void submit();
          }}
        >
          {(assistant.notice || stopError) && (
            <StatusMessage tone="error" className="px-1">
              {assistant.notice || stopError}
            </StatusMessage>
          )}
          <Composer variant="compact">
            <label htmlFor="workflow-assistant-input" className="sr-only">
              Message the assistant
            </label>
            <PromptTextarea
              inputRef={input}
              variant="ghost"
              rows={1}
              data-slot="composer-input"
              id="workflow-assistant-input"
              value={draft}
              maxLength={textLimit}
              placeholder={
                context.view === 'automations'
                  ? 'Describe what to run and when'
                  : 'Ask for a step or a workflow change'
              }
              disabled={!!blockedReason && !draft}
              skill={skill}
              scope={{
                hostId,
                provider: pick.provider,
                input: { provider: pick.provider, directory: directory.trim() },
              }}
              available={connected && !!directory.trim()}
              onChange={(value, nextSkill) => {
                setDraft(value);
                setSkill(nextSkill);
              }}
              onKeyDown={onComposerKeyDown}
              className="max-h-40 min-h-10 px-0.5"
            />
            <ComposerToolbar
              start={
                <>
                  <ModelPicker
                    provider={pick.provider}
                    model={pick.model}
                    effort={pick.effort}
                    statuses={statuses}
                    disabled={!connected || assistant.pending !== null}
                    onChange={(provider, model, effort) => {
                      const next = { provider, model, effort };
                      savePick(hostId, next);
                      setSavedPicks(previous => ({
                        ...previous,
                        [hostId]: next,
                      }));
                    }}
                    onRefreshProvider={onRefreshProvider}
                  />
                  <span role="status" className="min-w-0 truncate">
                    {blockedReason ||
                      (assistant.newConversation
                        ? 'Starts a new conversation with this model.'
                        : assistant.running
                          ? 'Working…'
                          : '')}
                  </span>
                </>
              }
              end={
                assistant.running ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    disabled={stopping || !connected}
                    aria-label="Stop the assistant"
                    onClick={() => void stop()}
                  >
                    <Square className="fill-current" />
                    {stopping ? 'Stopping…' : 'Stop'}
                  </Button>
                ) : (
                  <ComposerSend
                    label="Send to assistant"
                    shortcut="Enter"
                    disabled={
                      !!blockedReason ||
                      assistant.pending !== null ||
                      !draft.trim() ||
                      pendingSkillQuery(draft)
                    }
                  />
                )
              }
            />
          </Composer>
        </form>
      </SidePanelFooter>
    </SidePanel>,
    drawerHost,
  );
}
