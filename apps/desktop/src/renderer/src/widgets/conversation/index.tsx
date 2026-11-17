import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  FolderOpen,
  ListEnd,
  Monitor,
  Server,
  Square,
} from 'lucide-react';
import { cn } from 'cn';
import { attachmentLimits } from '@nesvo/contracts';
import type {
  DesktopApi,
  ReasoningEffort,
  RespondApprovalInput,
  SessionInterruption,
  SessionMode,
} from '@nesvo/contracts';
import {
  effortLabel,
  ModeIcon,
  modeLabel,
  modelLabel,
  providerStatusLabel,
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
import { ModeSwitch } from '@/features/session-mode/mode-switch';
import { cycleMode } from '@/features/session-mode/cycle-mode';
import {
  modelEfforts,
  resolveEffort,
} from '@/features/new-thread/reasoning-effort';
import { entityKey } from '@/shared/lib/host-key';
import { FailureNotice } from '@/features/failure-notice';
import { MessageBody } from './message-body';
import { CopyMessageButton } from './copy-message-button';
import { ClampedPrompt } from './clamped-prompt';
import { isLongPrompt } from './long-prompt';
import { AttachmentItem } from '@/features/attachments/attachment-item';
import {
  filesFrom,
  hasFiles,
  isLongPaste,
  takeAttachments,
  textAttachment,
  type PendingAttachment,
} from '@/features/attachments/paste-and-drop';
import type { AttachmentReader } from '@/features/attachments/use-attachment-content';

const MESSAGE_MAX_LENGTH = 32000;
const PASTE_NOTICE_MS = 5000;
const ATTACHMENT_NOTICE_MS = 8000;
const MODE_NOTICE_MS = 4000;
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
  onClear: () => void;
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
  modes: SessionMode[];
  pendingMode: SessionMode | null;
  onSelectMode: (mode: SessionMode | null) => void;
  canChangeMode: boolean;
  workflowChip?: ReactNode;
  attachments: PendingAttachment[];
  attachmentsEnabled: boolean;
  onAttach: (items: PendingAttachment[]) => void;
  onRemoveAttachment: (id: string) => void;
  readAttachment: AttachmentReader;
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
  onClear,
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
  modes,
  pendingMode,
  onSelectMode,
  canChangeMode,
  workflowChip,
  attachments,
  attachmentsEnabled,
  onAttach,
  onRemoveAttachment,
  readAttachment,
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
  const [attachmentNote, setAttachmentNote] = useState('');
  const attachmentNoteTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(attachmentNoteTimer.current), []);
  const [dragging, setDragging] = useState(false);
  const pastedTexts = useRef(0);
  const showAttachmentNote = (note: string) => {
    setAttachmentNote(note);
    window.clearTimeout(attachmentNoteTimer.current);
    if (note)
      attachmentNoteTimer.current = window.setTimeout(
        () => setAttachmentNote(''),
        ATTACHMENT_NOTICE_MS,
      );
  };
  const attachFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (!attachmentsEnabled) {
      showAttachmentNote(
        'Attachments need a newer Nesvo host on this computer. Update the host, then reconnect.',
      );
      return;
    }
    const intake = await takeAttachments(files, attachments.length);
    onAttach(intake.added);
    showAttachmentNote(intake.refusals.join(' '));
  };
  const attachPastedText = (text: string) => {
    if (attachments.length >= attachmentLimits.perMessage) {
      showAttachmentNote(
        `A message can carry up to ${attachmentLimits.perMessage} attachments.`,
      );
      return;
    }
    pastedTexts.current += 1;
    const result = textAttachment(text, pastedTexts.current);
    if ('refusal' in result) {
      showAttachmentNote(result.refusal);
      return;
    }
    onAttach([result]);
    showAttachmentNote('');
  };
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
  let recordedMode: SessionMode | null = null;
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
  const hasContent = !!draft.trim() || attachments.length > 0;
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
  const firstAgents = new Map<string, string>();
  for (const message of session.messages)
    if (message.author === 'agent' && !firstAgents.has(message.runId))
      firstAgents.set(message.runId, message.id);
  const queueButton = (
    <Button
      type="submit"
      size="icon-sm"
      className="size-7 rounded-full disabled:bg-send-idle disabled:text-send-idle-foreground disabled:opacity-100 [&_svg]:size-4"
      disabled={!hasContent || !canQueue}
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
  const clearConversation = () => {
    setRecall(null);
    onDraft('');
    onClear();
  };
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
      onClear={clearConversation}
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
            if (draft.trim() === '/clear') {
              clearConversation();
              return;
            }
            if (!hasContent || !canSubmit) return;
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
            <div
              data-dragging={dragging || undefined}
              onDragOver={event => {
                if (!hasFiles(event.dataTransfer)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                if (!dragging) setDragging(true);
              }}
              onDragLeave={event => {
                if (
                  !(event.relatedTarget instanceof Node) ||
                  !event.currentTarget.contains(event.relatedTarget)
                )
                  setDragging(false);
              }}
              onDrop={event => {
                if (!hasFiles(event.dataTransfer)) return;
                event.preventDefault();
                setDragging(false);
                void attachFiles(filesFrom(event.dataTransfer));
              }}
              className={cn(
                'glass-composer relative z-10 rounded-2xl border px-3 pt-3 pb-2 transition-colors duration-150 focus-within:border-input',
                dragging && 'border-ring bg-accent/40',
              )}
            >
              {selectedSkill && (
                <SelectedSkillChip
                  skill={selectedSkill}
                  onRemove={() => onSkillChange(null)}
                />
              )}
              {attachments.length > 0 && (
                <div
                  role="group"
                  aria-label="Attachments"
                  className="mb-2 flex flex-wrap gap-1"
                >
                  {attachments.map(item => (
                    <AttachmentItem
                      key={item.attachment.id}
                      attachment={item.attachment}
                      hostId={session.hostId}
                      sessionId={session.id}
                      read={readAttachment}
                      data={item.data}
                      preview={item.preview}
                      onRemove={() => onRemoveAttachment(item.attachment.id)}
                    />
                  ))}
                </div>
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
                  const files = filesFrom(event.clipboardData);
                  if (files.length > 0) {
                    event.preventDefault();
                    void attachFiles(files);
                    return;
                  }
                  const pasted = event.clipboardData.getData('text');
                  if (attachmentsEnabled && isLongPaste(pasted)) {
                    event.preventDefault();
                    attachPastedText(pasted);
                    return;
                  }
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
                  <span
                    role="status"
                    className="min-w-0 truncate text-[11px] leading-7 text-muted-foreground"
                  >
                    {otherRun
                      ? (otherRunLabel ?? 'Another session is working')
                      : running && hasContent
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
                  {running && hasContent && queueButton}
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
                      disabled={!hasContent || !canSend}
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
          {attachmentNote && (
            <p
              role="status"
              aria-label="Attachment note"
              className="px-3 text-[11px] leading-5 text-muted-foreground"
            >
              {attachmentNote}
            </p>
          )}
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
            <span
              data-session-mode={session.mode}
              className="flex h-7 shrink-0 items-center gap-1.5 px-1.5"
            >
              <ModeIcon
                mode={session.mode}
                className="size-3.5"
                aria-hidden="true"
              />
              {modeLabel(session.provider, session.mode)}
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
                  {message.author === 'operator' &&
                    message.attachments.length > 0 && (
                      <div
                        role="group"
                        aria-label="Message attachments"
                        className="flex max-w-[85%] flex-wrap justify-end gap-1"
                      >
                        {message.attachments.map(attachment => (
                          <AttachmentItem
                            key={attachment.id}
                            attachment={attachment}
                            hostId={session.hostId}
                            sessionId={session.id}
                            read={readAttachment}
                          />
                        ))}
                      </div>
                    )}
                  {(message.body ||
                    (!live &&
                      !(
                        message.author === 'operator' &&
                        message.attachments.length > 0
                      ))) &&
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
          {(session.error || session.failure) &&
            session.status !== 'interrupted' &&
            session.status !== 'completed' && (
              <FailureNotice
                key={session.runId}
                failure={session.failure}
                error={session.error ?? ''}
                provider={session.provider}
                computerName={computerName}
                canResend={canResend}
                resendDisabled={!canSend || sending}
                checking={statuses[session.provider].loading}
                providerStatus={providerStatusLabel(
                  session.provider,
                  statuses[session.provider],
                )}
                onResend={onResend}
                onCheckProvider={() => onRefreshProvider(session.provider)}
              />
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
                    {entry.attachments.length > 0 &&
                      ` · ${entry.attachments.length} ${entry.attachments.length === 1 ? 'attachment' : 'attachments'}`}
                  </span>
                  {entry.text && (
                    <MessageBody
                      body={entry.text}
                      className="max-w-[85%] rounded-2xl border border-dashed px-3.5 py-2 text-sm leading-6"
                    />
                  )}
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
