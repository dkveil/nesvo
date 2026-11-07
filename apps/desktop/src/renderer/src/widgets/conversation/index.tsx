import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUp, FolderOpen, Square } from 'lucide-react';
import type { RespondApprovalInput } from '@nesvo/contracts';
import {
  modeLabels,
  modelLabel,
  directoryLabel,
  statusLabels,
  type Session,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Textarea } from '@/shared/ui/textarea';

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
  sending: boolean;
  canSend: boolean;
  otherRun: boolean;
  approvalsEnabled: boolean;
  approvalPending: Record<string, boolean>;
  onApproval: (
    requestId: string,
    decision: RespondApprovalInput['decision'],
  ) => void;
  error: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
};

export function Conversation({
  session,
  focusTarget,
  workers,
  delegations,
  results,
  activity,
  draft,
  sending,
  canSend,
  otherRun,
  approvalsEnabled,
  approvalPending,
  onApproval,
  error,
  onDraft,
  onSend,
  onStop,
}: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const visibleSession = useRef('');
  const running = session.status === 'running' || session.status === 'stopping';
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
    session.delegations.length === 0;
  const runStarts = new Map(
    session.messages
      .filter(message => message.author === 'operator')
      .map(message => [message.runId, message.createdAt]),
  );
  const firstAgents = new Map<string, string>();
  for (const message of session.messages)
    if (message.author === 'agent' && !firstAgents.has(message.runId))
      firstAgents.set(message.runId, message.id);
  const composer = (
    <form
      className="mx-auto w-full max-w-3xl"
      onSubmit={event => {
        event.preventDefault();
        if (draft.trim() && canSend) onSend();
      }}
    >
      <label htmlFor="message-input" className="sr-only">
        Message
      </label>
      <div className="rounded-2xl border border-input/70 bg-card p-3 transition-colors focus-within:border-ring/70">
        <Textarea
          id="message-input"
          placeholder="Ask anything about your task…"
          value={draft}
          onChange={event => onDraft(event.target.value)}
          maxLength={32000}
          className="max-h-48 min-h-24 resize-none border-0 bg-transparent px-1 py-1 text-sm leading-6 shadow-none placeholder:text-muted-foreground/80 focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-end justify-between gap-3 px-1 pt-3">
          <span className="min-w-0 text-[11px] leading-5 text-muted-foreground">
            {otherRun
              ? 'Another session is working'
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
                    : modeLabels[session.mode]}
          </span>
          <div className="flex shrink-0 items-center gap-3">
            <span
              className="hidden max-w-56 truncate text-xs text-muted-foreground sm:inline"
              title={`${session.provider} · ${session.actualModel ?? modelLabel(session.model)}`}
            >
              {session.provider} ·{' '}
              {session.actualModel ?? modelLabel(session.model)}
            </span>
            {running ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={session.status === 'stopping'}
                onClick={onStop}
                aria-label={stopLabel}
                title={
                  groupRun
                    ? 'Stop this session and its workers'
                    : 'Stop this session'
                }
              >
                <Square />
                {session.status === 'stopping'
                  ? groupRun
                    ? 'Stopping group…'
                    : 'Stopping…'
                  : stopLabel}
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-sm"
                className="rounded-full disabled:bg-secondary disabled:text-muted-foreground"
                disabled={!draft.trim() || !canSend}
                aria-label="Send message"
                title="Send message"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-3 px-1 text-[11px] text-muted-foreground">
        <span
          className="flex min-w-0 items-center gap-1.5"
          title={session.directory}
          aria-label={`Working directory: ${session.directory}`}
        >
          <FolderOpen className="size-3 shrink-0" />
          <span className="truncate">{directoryLabel(session.directory)}</span>
        </span>
        <span className="truncate sm:hidden">
          {session.provider} ·{' '}
          {session.actualModel ?? modelLabel(session.model)}
        </span>
      </div>
    </form>
  );
  useEffect(() => {
    const viewport = bottom.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    );
    if (!viewport) return;
    const trackPosition = () => {
      followOutput.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 96;
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
  return (
    <section
      aria-label="Conversation"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ScrollArea
        className={
          empty ? 'h-0 min-h-0 shrink-0 overflow-hidden' : 'min-h-0 flex-1'
        }
      >
        <div className="mx-auto max-w-3xl space-y-10 px-5 py-10 lg:px-6">
          {session.messages.map(message => {
            const live =
              message.author === 'agent' &&
              message.runId === session.runId &&
              running;
            const showActivity =
              firstAgents.get(message.runId) === message.id &&
              (live ||
                !!message.completedAt ||
                session.activities.some(item => item.runId === message.runId));
            return (
              <article key={message.id} className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-medium">
                  <span>
                    {message.author === 'operator' ? 'You' : session.provider}
                  </span>
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
                {(message.body || !live) && (
                  <p className="text-sm leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {message.body || 'No response text.'}
                  </p>
                )}
              </article>
            );
          })}
          {delegations}
          {session.pendingApprovals.map(approval => {
            const pending =
              !!approvalPending[
                `${session.id}/${session.runId}/${approval.id}`
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
                <pre className="max-h-60 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
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
          {session.error && (
            <p
              role="alert"
              className="text-sm leading-relaxed whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]"
            >
              {session.error}
            </p>
          )}
          {session.status === 'interrupted' && (
            <p className="text-sm text-muted-foreground">
              The run was interrupted. Your history is saved; send a message to
              continue.
            </p>
          )}
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
        <div className="mx-auto mt-auto w-full max-w-3xl px-5 pt-10 pb-7 text-center lg:px-6">
          <h2 className="text-2xl font-medium tracking-tight sm:text-[1.875rem]">
            What would you like to work on?
          </h2>
        </div>
      )}
      <div
        className={`shrink-0 px-5 lg:px-6 ${empty ? 'mb-auto pb-12' : 'pt-3 pb-4'}`}
      >
        {composer}
      </div>
    </section>
  );
}
