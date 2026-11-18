import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  FolderOpen,
  ListEnd,
  Monitor,
  Server,
  Square,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import type {
  DesktopApi,
  ReasoningEffort,
  RespondApprovalInput,
  SessionMode,
} from '@nesvo/contracts';
import {
  effortLabel,
  ModeIcon,
  modeLabel,
  modelLabel,
  directoryLabel,
  statusLabels,
  type Provider,
  type ProviderStates,
  type Session,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import { CodeBlock } from '@/shared/ui/code-block';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { IconButton } from '@/shared/ui/icon-button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Separator } from '@/shared/ui/separator';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { SelectSkill, type SelectedSkill } from '@/features/select-skill';
import { SelectedSkillChip } from '@/features/select-skill/selected-skill-chip';
import { ModelPicker } from '@/features/new-thread/model-picker';
import { ModeSwitch } from '@/features/session-mode/mode-switch';
import { cycleMode } from '@/features/session-mode/cycle-mode';
import { mcpChangeLabel } from '@/features/session-mcp/mcp-labels';
import {
  modelEfforts,
  resolveEffort,
} from '@/features/new-thread/reasoning-effort';
import { entityKey } from '@/shared/lib/host-key';
import { MessageBody } from './message-body';
import { interruptionLabels } from './interruption-labels';
import { MessageArticle } from './message-article';

const MESSAGE_MAX_LENGTH = 32000;
const PASTE_NOTICE_MS = 5000;
const MODE_NOTICE_MS = 4000;
const NEAR_BOTTOM_PX = 96;
const ANNOUNCED_REPLY_LENGTH = 280;
const EAGER_TAIL_MESSAGES = 8;

export type ModelSelection = {
  model: string;
  effort: ReasoningEffort | null;
};

type Props = {
  session: Session;
  focusTarget: string;
  messageTarget: { id: string } | null;
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
  finishedWorktree?: boolean;
  onQueuedCancel: (messageId: string) => void;
  onQueuedStart: (messageId: string) => void;
  onQueuedEdit: (messageId: string, text: string) => void;
  statuses: ProviderStates;
  onRefreshProvider: (provider: Provider) => void;
  pendingSelection: ModelSelection | null;
  onSelectModel: (selection: ModelSelection | null) => void;
  modes: SessionMode[];
  pendingMode: SessionMode | null;
  onSelectMode: (mode: SessionMode | null) => void;
  canChangeMode: boolean;
  workflowChip?: ReactNode;
  mcpChip?: ReactNode;
};

export function Conversation({
  session,
  focusTarget,
  messageTarget,
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
  finishedWorktree,
  onQueuedCancel,
  onQueuedStart,
  onQueuedEdit,
  statuses,
  onRefreshProvider,
  pendingSelection,
  onSelectModel,
  modes,
  pendingMode,
  onSelectMode,
  canChangeMode,
  workflowChip,
  mcpChip,
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
  const [modeNotice, setModeNotice] = useState('');
  const modeNoticeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(modeNoticeTimer.current), []);
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
  const threadStarts = new Set(session.providerThreadStarts);
  const empty =
    session.messages.length === 0 &&
    !session.pendingClaudeFork &&
    threadStarts.size === 0 &&
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
  let recordedMode: SessionMode | null = null;
  let recordedMcp: Session['messages'][number]['mcp'] = null;
  for (const message of session.messages) {
    if (message.author !== 'operator') continue;
    const changes: string[] = [];
    if (message.model) {
      if (recorded?.model && recorded.model !== message.model)
        changes.push(
          `Model changed to ${labelFor(message.model)}${message.effort ? ` · ${effortLabel(message.effort)}` : ''}`,
        );
      else if (recorded && recorded.effort !== message.effort)
        changes.push(
          `Effort changed to ${message.effort ? effortLabel(message.effort) : 'Default'}`,
        );
      recorded = message;
    }
    if (message.mode) {
      if (recordedMode && recordedMode !== message.mode)
        changes.push(
          `Mode changed to ${modeLabel(session.provider, message.mode)}`,
        );
      recordedMode = message.mode;
    }
    if (message.mcp) {
      const change = recordedMcp && mcpChangeLabel(recordedMcp, message.mcp);
      if (change) changes.push(change);
      recordedMcp = message.mcp;
    }
    if (changes.length > 0)
      selectionChanges.set(message.id, changes.join(' · '));
  }
  const modeLockedReason =
    session.role === 'worker'
      ? 'Set by the parent decision'
      : session.workflowRunId
        ? 'Set when the workflow task started'
        : !canChangeMode
          ? 'Update the host to change modes'
          : '';
  const chooseMode = (next: SessionMode | null) => {
    onSelectMode(next === session.mode ? null : next);
  };
  const cycleSessionMode = () => {
    const next = cycleMode(modes, pendingMode ?? session.mode);
    chooseMode(next);
    setModeNotice(
      `Permission mode: ${modeLabel(session.provider, next)}${next === session.mode ? '' : ' from the next turn'}`,
    );
    window.clearTimeout(modeNoticeTimer.current);
    modeNoticeTimer.current = window.setTimeout(
      () => setModeNotice(''),
      MODE_NOTICE_MS,
    );
  };
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
  const HostIcon = session.hostId === 'local' ? Monitor : Server;
  const runStarts = new Map(
    session.messages
      .filter(message => message.author === 'operator')
      .map(message => [message.runId, message.createdAt]),
  );
  const activityRunIds = useMemo(
    () =>
      new Set([
        ...session.activityTruncatedRunIds,
        ...session.activities.map(item => item.runId),
      ]),
    [session.activities, session.activityTruncatedRunIds],
  );
  const lastAgent = session.messages.findLast(
    message => message.author === 'agent',
  );
  const latestApproval = session.pendingApprovals.at(-1);
  const announcement =
    running && latestApproval
      ? `${session.provider} needs approval: ${latestApproval.title}`
      : !running && lastAgent?.completedAt && lastAgent === lastMessage
        ? lastAgent.state === 'completed'
          ? `${session.provider} replied. ${lastAgent.body.slice(0, ANNOUNCED_REPLY_LENGTH)}`
          : `${session.provider}: ${statusLabels[lastAgent.state]}`
        : '';
  const firstAgents = new Map<string, string>();
  for (const message of session.messages)
    if (message.author === 'agent' && !firstAgents.has(message.runId))
      firstAgents.set(message.runId, message.id);
  const queueButton = (
    <Hint
      label={
        running
          ? 'Send when this turn ends'
          : 'Keep queued until you choose Send now'
      }
    >
      <ComposerSend
        label="Queue message"
        tooltip={false}
        disabled={!draft.trim() || !canQueue}
      >
        <ListEnd />
      </ComposerSend>
    </Hint>
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
            <Composer className="z-10">
              {selectedSkill && (
                <SelectedSkillChip
                  skill={selectedSkill}
                  onRemove={() => onSkillChange(null)}
                />
              )}
              <ComposerInput
                ref={messageInput}
                id="message-input"
                {...inputAria}
                onKeyDown={event => {
                  onKeyDown(event);
                  if (event.defaultPrevented) return;
                  const target = event.currentTarget;
                  if (
                    event.key === 'Tab' &&
                    event.shiftKey &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    if (!modeLockedReason && connected && modes.length > 1) {
                      event.preventDefault();
                      cycleSessionMode();
                    }
                    return;
                  }
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
              />
              <ComposerToolbar
                start={
                  <>
                    <ModeSwitch
                      provider={session.provider}
                      modes={modes}
                      mode={session.mode}
                      pendingMode={pendingMode}
                      disabled={!connected}
                      readOnlyReason={modeLockedReason}
                      onChange={chooseMode}
                    />
                    {workflowChip}
                    {mcpChip}
                    <span role="status" className="min-w-0 truncate">
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
                                : modeNotice}
                    </span>
                  </>
                }
                end={
                  <>
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
                      <Hint
                        label={
                          groupRun
                            ? 'Stop this session and its workers'
                            : 'Stop this session'
                        }
                      >
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="rounded-full"
                          disabled={!connected || session.status === 'stopping'}
                          onClick={onStop}
                          aria-label={stopLabel}
                        >
                          <Square className="fill-current" />
                          {session.status === 'stopping'
                            ? groupRun
                              ? 'Stopping group…'
                              : 'Stopping…'
                            : stopLabel}
                        </Button>
                      </Hint>
                    ) : otherRun ? (
                      queueButton
                    ) : (
                      <ComposerSend
                        disabled={!draft.trim() || !canSend}
                        shortcut="Enter"
                      />
                    )}
                  </>
                }
              />
            </Composer>,
          )}
          {notice}
          {(limitReached || pasteTruncated) && (
            <StatusMessage className="px-3">
              Message limit reached (32,000 characters). Shorten it or split it
              into several messages.
            </StatusMessage>
          )}
          <div className="flex min-w-0 items-center gap-1 px-2">
            <Hint label={computerName}>
              <Chip
                interactive={false}
                icon={<HostIcon aria-hidden="true" />}
                className="max-w-40"
              >
                <span>{computerName}</span>
              </Chip>
            </Hint>
            <Hint label={session.directory}>
              <Chip
                interactive={false}
                icon={<FolderOpen aria-hidden="true" />}
                aria-label={`Working directory: ${session.directory}`}
                className="shrink"
              >
                <span>{directoryLabel(session.directory)}</span>
              </Chip>
            </Hint>
            <span className="flex-1" />
            <Chip
              interactive={false}
              icon={<ModeIcon mode={session.mode} aria-hidden="true" />}
              data-session-mode={session.mode}
            >
              <span>{modeLabel(session.provider, session.mode)}</span>
            </Chip>
          </div>
          {!connected && (
            <StatusMessage className="px-3">
              Offline snapshot. Work may still be running. Reconnect to send
              messages or decisions.
            </StatusMessage>
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
  useEffect(() => {
    if (!messageTarget) return;
    const target = document.getElementById(`message-${messageTarget.id}`);
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    followOutput.current = false;
    const highlight = target.animate(
      [
        { backgroundColor: 'var(--accent)' },
        { backgroundColor: 'transparent' },
      ],
      { duration: 1800, easing: 'ease-out' },
    );
    return () => highlight.cancel();
  }, [messageTarget, session.id]);
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
      <p key={session.id} role="status" className="sr-only">
        {announcement}
      </p>
      <ScrollArea
        className={
          empty ? 'h-0 min-h-0 shrink-0 overflow-hidden' : 'min-h-0 flex-1'
        }
      >
        <div className="mx-auto w-full max-w-[calc(var(--chat-column-width)+2.5rem)] space-y-8 px-5 py-10">
          {session.pendingClaudeFork && session.messages.length === 0 && (
            <StatusMessage>
              Claude Code will fork the conversation on your next message.
            </StatusMessage>
          )}
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Messages"
            className="space-y-8"
          >
            {session.messages.map((message, index) => {
              const live =
                message.author === 'agent' &&
                message.runId === session.runId &&
                running;
              const showActivity =
                message.origin !== 'imported' &&
                firstAgents.get(message.runId) === message.id &&
                (live ||
                  !!message.completedAt ||
                  activityRunIds.has(message.runId));
              return (
                <MessageArticle
                  key={message.id}
                  message={message}
                  provider={session.provider}
                  live={live}
                  deferred={
                    !live &&
                    index < session.messages.length - EAGER_TAIL_MESSAGES
                  }
                  showActivity={showActivity}
                  activity={
                    showActivity &&
                    activity(
                      message.runId,
                      runStarts.get(message.runId) ?? null,
                      message.completedAt,
                      live ? session.status : message.state,
                      live,
                    )
                  }
                  showInterruption={message.runId !== session.runId}
                  selectionChange={selectionChanges.get(message.id)}
                  threadStart={threadStarts.has(index)}
                />
              );
            })}
            {threadStarts.has(session.messages.length) && (
              <Separator label="New provider thread" />
            )}
          </div>
          {session.error &&
            session.status !== 'interrupted' &&
            session.status !== 'completed' && (
              <section aria-label="Failed run" className="space-y-2">
                <StatusMessage
                  tone="error"
                  variant="notice"
                  className="whitespace-pre-wrap"
                >
                  {session.error}
                </StatusMessage>
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
            <section aria-label="Interrupted run" className="space-y-2">
              <StatusMessage tone="warning" variant="notice">
                <span className="block font-medium text-foreground">
                  {session.interruption
                    ? interruptionLabels[session.interruption.reason]
                    : 'This run was interrupted'}
                </span>
                {session.error ||
                  'The last outcome is unconfirmed. Review the current state before continuing.'}
              </StatusMessage>
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
                <StatusMessage
                  tone="warning"
                  variant="notice"
                  className="whitespace-pre-wrap"
                >
                  {queueStartError}
                </StatusMessage>
              )}
              {session.queue.map(entry => (
                <article
                  key={entry.id}
                  aria-label="Queued message"
                  className="flex flex-col items-end gap-1"
                >
                  <Hint label={entry.held ? 'Waiting for Send now' : ''}>
                    <Chip interactive={false} size="sm">
                      <span>{entry.held ? 'Held' : 'Queued'}</span>
                    </Chip>
                  </Hint>
                  <MessageBody
                    body={entry.text}
                    className="max-w-[85%] rounded-composer border border-dashed px-3.5 py-2 text-sm leading-6"
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
                className="space-y-3 rounded-surface border bg-card p-4"
              >
                <p className="text-2xs text-muted-foreground">
                  {approval.kind === 'command'
                    ? 'Command approval'
                    : 'File approval'}
                </p>
                <h2 className="text-sm font-medium [overflow-wrap:anywhere]">
                  {approval.title}
                </h2>
                <CodeBlock
                  code={approval.detail}
                  wrap
                  maxHeightClassName="max-h-60"
                  className="[overflow-wrap:anywhere]"
                />
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  Working directory: {approval.directory ?? session.directory}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={!enabled}
                    onClick={() => onApproval(approval.id, 'accept')}
                  >
                    Allow once
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!enabled}
                    onClick={() => onApproval(approval.id, 'decline')}
                  >
                    Deny
                  </Button>
                </div>
                <StatusMessage tone={pending ? 'loading' : 'info'}>
                  {pending
                    ? 'Sending decision…'
                    : enabled
                      ? 'Applies to this operation only.'
                      : 'This request is inactive. Refresh the connection to check its status.'}
                </StatusMessage>
              </section>
            );
          })}
          {results}
          {error && (
            <StatusMessage
              tone="error"
              variant="notice"
              className="whitespace-pre-wrap"
            >
              {error}
            </StatusMessage>
          )}
          <div ref={bottom} />
        </div>
      </ScrollArea>
      {empty && !finishedWorktree && (
        <div className="mx-auto mt-auto w-full max-w-(--composer-max-width) space-y-1 px-5 pt-10 pb-5 text-center">
          <h2 className="text-2xl font-normal tracking-tight sm:text-3xl">
            What would you like to work on?
          </h2>
          <p className="truncate text-ui font-semibold">
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
          <IconButton
            label="Scroll to end"
            shape="round"
            className="glass-popover absolute -top-9 left-1/2 z-20 -translate-x-1/2 border"
            onMouseDown={event => event.preventDefault()}
            onClick={scrollToEnd}
          >
            <ArrowDown />
          </IconButton>
        )}
        {finishedWorktree ? (
          <StatusMessage
            tone="info"
            className="mx-auto max-w-(--composer-max-width)"
          >
            This worktree session is finished.
          </StatusMessage>
        ) : (
          composer
        )}
      </div>
    </section>
  );
}
