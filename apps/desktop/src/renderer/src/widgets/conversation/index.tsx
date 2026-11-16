import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  FolderOpen,
  ListEnd,
  Lock,
  Monitor,
  Pencil,
  Server,
  Square,
} from 'lucide-react';
import { cn } from 'cn';
import type {
  DesktopApi,
  ReasoningEffort,
  RespondApprovalInput,
  SessionInterruption,
} from '@nesvo/contracts';
import {
  effortLabel,
  modeLabels,
  modelLabel,
  directoryLabel,
  statusLabels,
  type Provider,
  type ProviderStates,
  type Session,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Textarea } from '@/shared/ui/textarea';
import { SelectSkill, type SelectedSkill } from '@/features/select-skill';
import { SelectedSkillChip } from '@/features/select-skill/selected-skill-chip';
import { ModelPicker } from '@/features/new-thread/model-picker';
import {
  modelEfforts,
  resolveEffort,
} from '@/features/new-thread/reasoning-effort';
import { entityKey } from '@/shared/lib/host-key';
import { MessageBody } from './message-body';
import { CopyMessageButton } from './copy-message-button';
import { ClampedPrompt } from './clamped-prompt';
import { isLongPrompt } from './long-prompt';

const MESSAGE_MAX_LENGTH = 32000;
const PASTE_NOTICE_MS = 5000;
const NEAR_BOTTOM_PX = 96;

const interruptionLabels: Record<SessionInterruption['reason'], string> = {
  'host-shutdown': 'Interrupted when Nesvo closed',
  'host-restart': 'Recovered after the host stopped unexpectedly',
  'provider-disconnected': 'Agent connection ended unexpectedly',
};

export type ModelSelection = {
  model: string;
  effort: ReasoningEffort | null;
};

type Props = {
  session: Session;
  focusTarget: string;
  workers: Session[];
  delegations: ReactNode;
  results: ReactNode;
  activity: (
    runId: string,
    startedAt: string | null,
    completedAt: string | null,
    status: Session['status'],
    live: boolean,
  ) => ReactNode;
  draft: string;
  selectedSkill: SelectedSkill | null;
  connected: boolean;
  computerName: string;
  skillApi: Pick<DesktopApi, 'discoverSkills'>;
  onSkillChange: (skill: SelectedSkill | null) => void;
  sending: boolean;
  canSend: boolean;
  otherRun: boolean;
  otherRunLabel?: ReactNode;
  approvalsEnabled: boolean;
  approvalPending: Record<string, boolean>;
  onApproval: (
    requestId: string,
    decision: RespondApprovalInput['decision'],
  ) => void;
  error: string;
  onDraft: (value: string) => void;
  onSend: (typed?: { text: string; skill: SelectedSkill }) => void;
  onStop: () => void;
  onResend: () => void;
  canQueue: boolean;
  onQueuedCancel: (messageId: string) => void;
  onQueuedStart: (messageId: string) => void;
  onQueuedEdit: (messageId: string, text: string) => void;
  statuses: ProviderStates;
  onRefreshProvider: (provider: Provider) => void;
  pendingSelection: ModelSelection | null;
  onSelectModel: (selection: ModelSelection | null) => void;
};

export function Conversation({
  session,
  focusTarget,
  workers,
  delegations,
  results,
  activity,
  draft,
  selectedSkill,
  connected,
  computerName,
  skillApi,
  onSkillChange,
  sending,
  canSend,
  otherRun,
  otherRunLabel,
  approvalsEnabled,
  approvalPending,
  onApproval,
  error,
  onDraft,
  onSend,
  onStop,
  onResend,
  canQueue,
  onQueuedCancel,
  onQueuedStart,
  onQueuedEdit,
  statuses,
  onRefreshProvider,
  pendingSelection,
  onSelectModel,
}: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const latestDraft = useRef(draft);
  useEffect(() => {
    latestDraft.current = draft;
  }, [draft]);
  const followOutput = useRef(true);
  const jumping = useRef(false);
  const [jumpSessionId, setJumpSessionId] = useState('');
  const [recallState, setRecall] = useState<{
    sessionId: string;
    index: number;
    text: string;
  } | null>(null);
  const recall = recallState?.sessionId === session.id ? recallState : null;
  const [pasteTruncated, setPasteTruncated] = useState(false);
  const pasteTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(pasteTimer.current), []);
  const visibleSession = useRef('');
  const running = session.status === 'running' || session.status === 'stopping';
  const queueing = running || otherRun;
  const canSubmit = queueing ? canQueue : canSend;
  const groupRun =
    !session.parentId &&
    (session.delegations.some(
      delegation =>
        delegation.runId === session.runId &&
        (delegation.status === 'pending' || delegation.childSessionId),
    ) ||
      workers.some(worker => worker.parentRunId === session.runId));
  const stopLabel = groupRun ? 'Stop group' : 'Stop';
  const empty =
    session.messages.length === 0 &&
    !running &&
    !session.error &&
    !error &&
    session.pendingApprovals.length === 0 &&
    session.delegations.length === 0 &&
    session.queue.length === 0;
  const providerState = statuses[session.provider];
  const labelFor = (id: string) =>
    providerState.status?.models.find(option => option.id === id)?.label ??
    modelLabel(id);
  const model = labelFor(session.actualModel ?? session.model);
  const selectionChanges = new Map<string, string>();
  let recorded: Session['messages'][number] | undefined;
  for (const message of session.messages) {
    if (message.author !== 'operator' || !message.model) continue;
    if (recorded?.model && recorded.model !== message.model)
      selectionChanges.set(
        message.id,
        `Model changed to ${labelFor(message.model)}${message.effort ? ` · ${effortLabel(message.effort)}` : ''}`,
      );
    else if (recorded && recorded.effort !== message.effort)
      selectionChanges.set(
        message.id,
        `Effort changed to ${message.effort ? effortLabel(message.effort) : 'Default'}`,
      );
    recorded = message;
  }
  const chooseModel = (nextModel: string, nextEffort: string) => {
    if (nextModel === session.model && nextEffort === (session.effort ?? '')) {
      onSelectModel(null);
      return;
    }
    const effort =
      resolveEffort(modelEfforts(providerState, nextModel), nextEffort) || null;
    onSelectModel(
      nextModel === session.model && effort === session.effort
        ? null
        : { model: nextModel, effort },
    );
  };
  const operatorBodies = session.messages
    .filter(message => message.author === 'operator')
    .map(message => message.body);
  const limitReached = draft.length >= MESSAGE_MAX_LENGTH;
  const lastMessage = session.messages.at(-1);
  const lastOperator = session.messages.findLast(
    message => message.author === 'operator',
  );
  const canResend =
    !running &&
    !!lastOperator &&
    !lastOperator.skill &&
    !lastOperator.skillId &&
    lastMessage?.author === 'agent' &&
    (lastMessage.state === 'failed' || lastMessage.state === 'interrupted');
  const queueStartError =
    session.status === 'completed' && session.queue.length > 0
      ? session.error
      : '';
  const ModeIcon = session.mode === 'supervised' ? Pencil : Lock;
  const HostIcon = session.hostId === 'local' ? Monitor : Server;
  const runStarts = new Map(
    session.messages
      .filter(message => message.author === 'operator')
      .map(message => [message.runId, message.createdAt]),
  );
  const firstAgents = new Map<string, string>();
  for (const message of session.messages)
    if (message.author === 'agent' && !firstAgents.has(message.runId))
      firstAgents.set(message.runId, message.id);
  const queueButton = (
    <Button
      type="submit"
      size="icon-sm"
      className="size-7 rounded-full disabled:bg-send-idle disabled:text-send-idle-foreground disabled:opacity-100 [&_svg]:size-4"
      disabled={!draft.trim() || !canQueue}
      aria-label="Queue message"
      title={
        running
          ? 'Send when this turn ends'
          : 'Keep queued until you choose Send now'
      }
    >
      <ListEnd />
    </Button>
  );
  const composer = (
    <SelectSkill
      key={entityKey(session)}
      scope={{
        hostId: session.hostId,
        provider: session.provider,
        input: { sessionId: session.id },
      }}
      api={skillApi}
      enabled={connected}
      draft={draft}
      onSelect={skill => {
        onSkillChange(skill);
        if (draft.startsWith('/')) onDraft(draft.replace(/^\/[^\s]*\s?/, ''));
      }}
      onFocusMessage={() => messageInput.current?.focus()}
    >
      {({
        trigger,
        anchor,
        notice,
        onKeyDown,
        onInput,
        hasTypedCommand,
        resolveTyped,
        inputAria,
      }) => (
        <form
          className="mx-auto w-full max-w-(--composer-max-width) space-y-2"
          onSubmit={event => {
            event.preventDefault();
            if (!draft.trim() || !canSubmit) return;
            setRecall(null);
            if (selectedSkill || !hasTypedCommand) {
              onSend();
              return;
            }
            const submitted = draft;
            void resolveTyped(submitted).then(typed => {
              if (latestDraft.current !== submitted) return;
              if (typed.status === 'skill')
                onSend({ text: typed.text, skill: typed.skill });
              else if (typed.status === 'none') onSend();
            });
          }}
        >
          <label htmlFor="message-input" className="sr-only">
            Message
          </label>
          {anchor(
            <div className="glass-composer relative z-10 rounded-2xl border px-3 pt-3 pb-2 transition-colors duration-150 focus-within:border-input">
              {selectedSkill && (
                <SelectedSkillChip
                  skill={selectedSkill}
                  onRemove={() => onSkillChange(null)}
                />
              )}
              <Textarea
                ref={messageInput}
                id="message-input"
                {...inputAria}
                onKeyDown={event => {
                  onKeyDown(event);
                  if (event.defaultPrevented) return;
                  const target = event.currentTarget;
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    if (!running || canQueue) target.form?.requestSubmit();
                    return;
                  }
                  if (
                    event.shiftKey ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.nativeEvent.isComposing ||
                    target.selectionStart !== target.selectionEnd
                  )
                    return;
                  if (draft && draft !== recall?.text) return;
                  if (event.key === 'ArrowUp') {
                    if (
                      target.value
                        .slice(0, target.selectionStart)
                        .includes('\n')
                    )
                      return;
                    const index = recall
                      ? Math.max(0, recall.index - 1)
                      : operatorBodies.length - 1;
                    const text = operatorBodies[index];
                    if (!text) return;
                    event.preventDefault();
                    setRecall({ sessionId: session.id, index, text });
                    onDraft(text);
                  } else if (event.key === 'ArrowDown' && recall) {
                    if (target.value.slice(target.selectionEnd).includes('\n'))
                      return;
                    event.preventDefault();
                    const index = recall.index + 1;
                    const text = operatorBodies[index];
                    if (text) {
                      setRecall({ sessionId: session.id, index, text });
                      onDraft(text);
                    } else {
                      setRecall(null);
                      onDraft('');
                    }
                  }
                }}
                onPaste={event => {
                  const target = event.currentTarget;
                  const pasted = event.clipboardData.getData('text');
                  const selected = target.selectionEnd - target.selectionStart;
                  if (
                    draft.length - selected + pasted.length <=
                    MESSAGE_MAX_LENGTH
                  )
                    return;
                  setPasteTruncated(true);
                  window.clearTimeout(pasteTimer.current);
                  pasteTimer.current = window.setTimeout(
                    () => setPasteTruncated(false),
                    PASTE_NOTICE_MS,
                  );
                }}
                onInput={onInput}
                placeholder="Ask anything. / for skills"
                value={draft}
                onChange={event => {
                  setRecall(null);
                  onDraft(event.target.value);
                }}
                maxLength={MESSAGE_MAX_LENGTH}
                className="max-h-48 min-h-11 resize-none rounded-none border-0 bg-transparent px-1 py-0 text-sm leading-5 shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0 dark:bg-transparent"
              />
              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="flex min-w-0 items-center gap-2">
                  {trigger}
                  <span className="min-w-0 truncate text-[11px] leading-7 text-muted-foreground">
                    {otherRun
                      ? (otherRunLabel ?? 'Another session is working')
                      : running && draft.trim()
                        ? 'Will send when this turn ends'
                        : sending
                          ? 'Sending…'
                          : session.delegations.some(
                                delegation =>
                                  delegation.runId === session.runId &&
                                  delegation.status === 'pending',
                              )
                            ? 'Worker approval needed'
                            : session.pendingApprovals.length > 0
                              ? 'Approval needed'
                              : ''}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <ModelPicker
                    provider={session.provider}
                    model={pendingSelection?.model ?? session.model}
                    effort={
                      (pendingSelection
                        ? pendingSelection.effort
                        : session.effort) ?? ''
                    }
                    statuses={statuses}
                    disabled={!connected}
                    lockedProvider
                    triggerLabel="Change model"
                    displayLabel={
                      pendingSelection
                        ? labelFor(pendingSelection.model)
                        : model
                    }
                    hint={pendingSelection ? 'next turn' : undefined}
                    triggerClassName="min-w-0 px-1.5 text-xs"
                    onChange={(_provider, nextModel, nextEffort) =>
                      chooseModel(nextModel, nextEffort)
                    }
                    onRefreshProvider={onRefreshProvider}
                  />
                  {running && !!draft.trim() && queueButton}
                  {running ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="h-7 rounded-full px-2.5"
                      disabled={!connected || session.status === 'stopping'}
                      onClick={onStop}
                      aria-label={stopLabel}
                      title={
                        groupRun
                          ? 'Stop this session and its workers'
                          : 'Stop this session'
                      }
                    >
                      <Square className="fill-current" />
                      {session.status === 'stopping'
                        ? groupRun
                          ? 'Stopping group…'
                          : 'Stopping…'
                        : stopLabel}
                    </Button>
                  ) : otherRun ? (
                    queueButton
                  ) : (
                    <Button
                      type="submit"
                      size="icon-sm"
                      className="size-7 rounded-full disabled:bg-send-idle disabled:text-send-idle-foreground disabled:opacity-100 [&_svg]:size-4"
                      disabled={!draft.trim() || !canSend}
                      aria-label="Send message"
                      title="Send message"
                    >
                      <ArrowUp />
                    </Button>
                  )}
                </div>
              </div>
            </div>,
          )}
          {notice}
          {(limitReached || pasteTruncated) && (
            <p
              role="status"
              className="px-3 text-[11px] leading-5 text-muted-foreground"
            >
              Message limit reached (32,000 characters). Shorten it or split it
              into several messages.
            </p>
          )}
          <div className="flex min-w-0 items-center gap-1 px-2 text-xs text-muted-foreground">
            <span
              className="flex h-7 max-w-40 min-w-0 items-center gap-1.5 px-1.5"
              title={computerName}
            >
              <HostIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{computerName}</span>
            </span>
            <span
              className="flex h-7 min-w-0 items-center gap-1.5 px-1.5"
              title={session.directory}
              aria-label={`Working directory: ${session.directory}`}
            >
              <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {directoryLabel(session.directory)}
              </span>
            </span>
            <span className="flex-1" />
            <span className="flex h-7 shrink-0 items-center gap-1.5 px-1.5">
              <ModeIcon className="size-3.5" aria-hidden="true" />
              {modeLabels[session.mode]}
            </span>
          </div>
          {!connected && (
            <p className="px-3 text-[11px] leading-5 text-muted-foreground">
              Offline snapshot. Work may still be running. Reconnect to send
              messages or decisions.
            </p>
          )}
        </form>
      )}
    </SelectSkill>
  );
  useEffect(() => {
    const viewport = bottom.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    const trackPosition = () => {
      const near =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
        NEAR_BOTTOM_PX;
      if (jumping.current) {
        if (!near) return;
        jumping.current = false;
      }
      followOutput.current = near;
      setJumpSessionId(
        !near && viewport.scrollHeight > viewport.clientHeight
          ? session.id
          : '',
      );
    };
    viewport.addEventListener('scroll', trackPosition, { passive: true });
    return () => viewport.removeEventListener('scroll', trackPosition);
  }, [session.id]);
  useEffect(() => {
    if (visibleSession.current !== session.id || followOutput.current) {
      bottom.current?.scrollIntoView({ block: 'end' });
      followOutput.current = true;
    }
    visibleSession.current = session.id;
  }, [session.id, session.revision]);
  useEffect(() => {
    if (!focusTarget) return;
    const target = document.getElementById(focusTarget);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      followOutput.current = false;
    }
  }, [session.id, focusTarget]);
  const scrollToEnd = () => {
    const viewport = bottom.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    jumping.current = true;
    followOutput.current = true;
    setJumpSessionId('');
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
  };
  return (
    <section
      aria-label="Conversation"
      data-host-id={session.hostId}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ScrollArea
        className={
          empty ? 'h-0 min-h-0 shrink-0 overflow-hidden' : 'min-h-0 flex-1'
        }
      >
        <div className="mx-auto w-full max-w-[calc(var(--chat-column-width)+2.5rem)] space-y-8 px-5 py-10">
          {session.messages.map(message => {
            const live =
              message.author === 'agent' &&
              message.runId === session.runId &&
              running;
            const showActivity =
              firstAgents.get(message.runId) === message.id &&
              (live ||
                !!message.completedAt ||
                session.activityTruncatedRunIds.includes(message.runId) ||
                session.activities.some(item => item.runId === message.runId));
            const selectionChange = selectionChanges.get(message.id);
            return (
              <Fragment key={message.id}>
                {selectionChange && (
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="h-px flex-1 bg-border"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {selectionChange}
                    </p>
                    <span
                      aria-hidden="true"
                      className="h-px flex-1 bg-border"
                    />
                  </div>
                )}
                <article
                  aria-label={
                    message.author === 'operator' ? 'You' : session.provider
                  }
                  data-author={message.author}
                  className={cn(
                    'group space-y-2',
                    message.author === 'operator' && 'flex flex-col items-end',
                  )}
                >
                  <div className="flex max-w-full items-center gap-2 text-xs empty:hidden">
                    {message.author === 'operator' &&
                      (message.skill || message.skillId) && (
                        <span
                          aria-label={
                            message.skill
                              ? `Requested skill: ${message.skill.name}`
                              : 'Unresolved skill request'
                          }
                          title={
                            message.skill
                              ? [
                                  `${message.skill.source} · ${message.skill.path}`,
                                  message.skill.origins?.join(', '),
                                  message.skill.delivery === 'instructions'
                                    ? 'Shared instructions · static snapshot for this message'
                                    : message.skill.delivery === 'native'
                                      ? 'Native skill'
                                      : '',
                                  message.skill.contentHash
                                    ? `SHA-256: ${message.skill.contentHash}`
                                    : message.skillHash
                                      ? `SHA-256: ${message.skillHash}`
                                      : '',
                                ]
                                  .filter(Boolean)
                                  .join('\n')
                              : 'A skill was requested, but its source was not resolved.'
                          }
                          className="max-w-[70%] truncate rounded border px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground"
                        >
                          {message.skill?.name ?? 'Requested skill'}
                          {message.skill?.delivery === 'instructions' && (
                            <span className="ml-2">Shared instructions</span>
                          )}
                        </span>
                      )}
                    {message.author === 'agent' &&
                      message.state !== 'completed' &&
                      !showActivity && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {statusLabels[message.state]}
                        </span>
                      )}
                  </div>
                  {showActivity &&
                    activity(
                      message.runId,
                      runStarts.get(message.runId) ?? null,
                      message.completedAt,
                      live ? session.status : message.state,
                      live,
                    )}
                  {(message.body || !live) &&
                    (message.author === 'operator' ? (
                      isLongPrompt(message.body) ? (
                        <ClampedPrompt>
                          <MessageBody
                            body={message.body}
                            className="rounded-2xl bg-message-surface px-3.5 py-2 text-sm leading-6"
                          />
                        </ClampedPrompt>
                      ) : (
                        <MessageBody
                          body={message.body || 'No response text.'}
                          className="max-w-[85%] rounded-2xl bg-message-surface px-3.5 py-2 text-sm leading-6"
                        />
                      )
                    ) : (
                      <MessageBody
                        body={message.body || 'No response text.'}
                        className="w-full text-sm leading-7"
                      />
                    ))}
                  {message.author === 'agent' && !live && message.body && (
                    <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <CopyMessageButton body={message.body} />
                    </div>
                  )}
                  {message.interruption && message.runId !== session.runId && (
                    <p className="text-xs text-muted-foreground">
                      {interruptionLabels[message.interruption.reason]}
                    </p>
                  )}
                </article>
              </Fragment>
            );
          })}
          {session.error &&
            session.status !== 'interrupted' &&
            session.status !== 'completed' && (
              <section
                role="alert"
                aria-label="Failed run"
                className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3"
              >
                <p className="text-sm leading-relaxed whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]">
                  {session.error}
                </p>
                {canResend && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={!canSend || sending}
                    onClick={onResend}
                  >
                    Resend last message
                  </Button>
                )}
              </section>
            )}
          {session.status === 'interrupted' && (
            <section
              aria-label="Interrupted run"
              className="space-y-2 rounded-xl border px-4 py-3"
            >
              <p className="text-xs font-medium">
                {session.interruption
                  ? interruptionLabels[session.interruption.reason]
                  : 'This run was interrupted'}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {session.error ||
                  'The last outcome is unconfirmed. Review the current state before continuing.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {canResend && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={!canSend || sending}
                    onClick={onResend}
                  >
                    Resend last message
                  </Button>
                )}
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={!canSend || sending}
                  onClick={() => messageInput.current?.focus()}
                >
                  Continue conversation
                </Button>
              </div>
            </section>
          )}
          {delegations}
          {session.queue.length > 0 && (
            <section aria-label="Queued messages" className="space-y-3">
              {queueStartError && (
                <p className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                  {queueStartError}
                </p>
              )}
              {session.queue.map(entry => (
                <article
                  key={entry.id}
                  aria-label="Queued message"
                  title={entry.held ? 'Waiting for Send now' : undefined}
                  className="flex flex-col items-end gap-1"
                >
                  <span className="text-[11px] text-muted-foreground">
                    {entry.held ? 'Held' : 'Queued'}
                  </span>
                  <MessageBody
                    body={entry.text}
                    className="max-w-[85%] rounded-2xl border border-dashed px-3.5 py-2 text-sm leading-6"
                  />
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={!canQueue}
                      onClick={() => onQueuedEdit(entry.id, entry.text)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={!canQueue}
                      onClick={() => onQueuedCancel(entry.id)}
                    >
                      Remove
                    </Button>
                    {!running && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={!canSend}
                        onClick={() => onQueuedStart(entry.id)}
                      >
                        Send now
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}
          {session.pendingApprovals.map(approval => {
            const pending =
              !!approvalPending[
                `${entityKey(session)}/${session.runId}/${approval.id}`
              ];
            const enabled =
              approvalsEnabled &&
              session.status === 'running' &&
              !!session.runId &&
              !pending;
            return (
              <section
                key={`${session.runId}/${approval.id}`}
                id={`approval-${approval.id}`}
                aria-label="Operation approval"
                className="space-y-3 rounded-xl border bg-card/70 p-4"
              >
                <p className="text-xs text-muted-foreground">
                  {approval.kind === 'command'
                    ? 'Command approval'
                    : 'File approval'}
                </p>
                <h2 className="text-sm font-medium [overflow-wrap:anywhere]">
                  {approval.title}
                </h2>
                <pre className="max-h-60 overflow-auto rounded-lg border bg-code-background p-3 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {approval.detail}
                </pre>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  Working directory: {approval.directory ?? session.directory}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!enabled}
                    onClick={() => onApproval(approval.id, 'accept')}
                  >
                    Allow once
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!enabled}
                    onClick={() => onApproval(approval.id, 'decline')}
                  >
                    Deny
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {pending
                    ? 'Sending decision…'
                    : enabled
                      ? 'Applies to this operation only.'
                      : 'This request is inactive. Refresh the connection to check its status.'}
                </p>
              </section>
            );
          })}
          {results}
          {error && (
            <p
              role="alert"
              className="text-sm leading-relaxed whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
          )}
          <div ref={bottom} />
        </div>
      </ScrollArea>
      {empty && (
        <div className="mx-auto mt-auto w-full max-w-(--composer-max-width) space-y-1 px-5 pt-10 pb-5 text-center">
          <h2 className="text-2xl font-normal tracking-tight sm:text-3xl">
            What would you like to work on?
          </h2>
          <p className="truncate text-[13px] font-semibold">
            {directoryLabel(session.directory)}
          </p>
        </div>
      )}
      <div
        className={cn(
          'relative shrink-0 px-5',
          empty ? 'mb-auto pb-16' : 'pt-2 pb-4',
        )}
      >
        {jumpSessionId === session.id && !empty && (
          <button
            type="button"
            aria-label="Scroll to end"
            className="absolute -top-9 left-1/2 z-20 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/90 px-3 text-xs text-muted-foreground shadow-sm backdrop-blur hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            onMouseDown={event => event.preventDefault()}
            onClick={scrollToEnd}
          >
            <ArrowDown className="size-3.5" aria-hidden="true" />
            Scroll to end
          </button>
        )}
        {composer}
      </div>
    </section>
  );
}
