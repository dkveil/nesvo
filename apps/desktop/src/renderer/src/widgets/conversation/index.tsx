import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUp, Bot, CircleUserRound, Square } from 'lucide-react';
import type { RespondApprovalInput } from '@nesvo/contracts';
import {
  modeLabels,
  modelLabel,
  roleLabels,
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
  const stopLabel = groupRun ? 'Stop grupy' : 'Stop';
  const empty =
    session.messages.length === 0 &&
    !running &&
    !session.error &&
    !error &&
    session.pendingApprovals.length === 0 &&
    session.delegations.length === 0;
  const composer = (
    <form
      className="mx-auto w-full max-w-3xl"
      onSubmit={event => {
        event.preventDefault();
        if (draft.trim() && canSend) onSend();
      }}
    >
      <label htmlFor="message-input" className="sr-only">
        Wiadomość
      </label>
      <div className="rounded-2xl border border-input/70 bg-card p-3 transition-colors focus-within:border-ring/70">
        <Textarea
          id="message-input"
          placeholder="Napisz, czym chcesz się zająć…"
          value={draft}
          onChange={event => onDraft(event.target.value)}
          maxLength={32000}
          className="max-h-48 min-h-20 resize-none border-0 bg-transparent px-1 py-1 text-sm leading-6 shadow-none placeholder:text-muted-foreground/80 focus-visible:ring-0 dark:bg-transparent"
        />
        <div className="flex items-end justify-between gap-3 px-1 pt-3">
          <span className="min-w-0 text-[11px] leading-5 text-muted-foreground">
            {otherRun
              ? 'Trwa praca w innej sesji'
              : sending
                ? 'Wysyłanie…'
                : session.delegations.some(
                      delegation =>
                        delegation.runId === session.runId &&
                        delegation.status === 'pending',
                    )
                  ? 'Oczekuje na decyzję o workerach'
                  : session.pendingApprovals.length > 0
                    ? 'Oczekuje na decyzję operatora'
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
                    ? 'Zatrzymaj orkiestratora i jego workerów'
                    : 'Zatrzymaj tę sesję'
                }
              >
                <Square />
                {session.status === 'stopping'
                  ? groupRun
                    ? 'Zatrzymywanie grupy…'
                    : 'Zatrzymywanie…'
                  : stopLabel}
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-sm"
                className="rounded-full disabled:bg-secondary disabled:text-muted-foreground"
                disabled={!draft.trim() || !canSend}
                aria-label="Wyślij wiadomość"
                title="Wyślij wiadomość"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 truncate px-1 text-[11px] text-muted-foreground sm:hidden">
        {session.provider} · {session.actualModel ?? modelLabel(session.model)}
      </p>
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
      aria-label="Rozmowa"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ScrollArea
        className={
          empty ? 'h-0 min-h-0 shrink-0 overflow-hidden' : 'min-h-0 flex-1'
        }
      >
        <div className="mx-auto max-w-3xl space-y-9 px-5 py-10 lg:px-6">
          {session.messages.map(message => (
            <article key={message.id} className="flex gap-3.5">
              <div className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                {message.author === 'operator' ? (
                  <CircleUserRound className="size-4" />
                ) : (
                  <Bot className="size-4" />
                )}
              </div>
              <div className="min-w-0 space-y-2 pt-0.5">
                <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                  {message.author === 'operator'
                    ? 'Ty'
                    : roleLabels[session.role]}
                  {message.author === 'agent' && (
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {session.provider} · {statusLabels[message.state]}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {message.body ||
                    (message.state === 'running'
                      ? 'Oczekiwanie na odpowiedź…'
                      : 'Brak treści odpowiedzi.')}
                </p>
              </div>
            </article>
          ))}
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
                aria-label="Zgoda operatora"
                className="space-y-3 rounded-xl border bg-card/70 p-4"
              >
                <p className="text-xs text-muted-foreground">
                  {approval.kind === 'command'
                    ? 'Polecenie wymaga zgody'
                    : 'Zmiana plików wymaga zgody'}
                </p>
                <h2 className="text-sm font-medium [overflow-wrap:anywhere]">
                  {approval.title}
                </h2>
                <pre className="max-h-60 overflow-auto rounded-md bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {approval.detail}
                </pre>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  Katalog pracy: {approval.directory ?? session.directory}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!enabled}
                    onClick={() => onApproval(approval.id, 'accept')}
                  >
                    Zezwól jednorazowo
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!enabled}
                    onClick={() => onApproval(approval.id, 'decline')}
                  >
                    Odmów
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {pending
                    ? 'Przekazywanie decyzji…'
                    : enabled
                      ? 'Decyzja dotyczy tylko tej operacji.'
                      : 'Zgoda jest nieaktywna. Odśwież połączenie, aby sprawdzić aktualny stan.'}
                </p>
              </section>
            );
          })}
          {results}
          {session.activity && running && (
            <p
              role="status"
              className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
            >
              {session.activity}
            </p>
          )}
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
              Uruchomienie zostało przerwane. Historia jest zachowana; możesz
              wysłać kolejną wiadomość.
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
            Od czego zaczynamy?
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">
            Opisz zadanie dla {session.provider}.
          </p>
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
