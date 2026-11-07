import { useEffect, useRef, type ReactNode } from 'react';
import {
  ArrowUp,
  Bot,
  CircleUserRound,
  MessageSquare,
  Square,
} from 'lucide-react';
import type { RespondApprovalInput } from '@nesvo/contracts';
import {
  modeLabels,
  roleLabels,
  statusLabels,
  type Session,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { Textarea } from '@/shared/ui/textarea';

type Props = {
  session: Session;
  workers: Session[];
  delegations: ReactNode;
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
  workers,
  delegations,
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
  return (
    <section
      aria-label="Rozmowa"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl space-y-8 px-5 py-8 lg:px-8">
          {session.messages.length === 0 && (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
              <MessageSquare className="size-7 text-muted-foreground" />
              <h2 className="text-lg font-medium">Od czego zaczynamy?</h2>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                Opisz cel i zakres analizy. Agent odpowie w wybranym trybie
                pracy.
              </p>
            </div>
          )}
          {session.messages.map(message => (
            <article key={message.id} className="flex gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
                {message.author === 'operator' ? (
                  <CircleUserRound className="size-4" />
                ) : (
                  <Bot className="size-4" />
                )}
              </div>
              <div className="min-w-0 space-y-2 pt-0.5">
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {message.author === 'operator'
                    ? 'Ty'
                    : roleLabels[session.role]}
                  {message.author === 'agent' && (
                    <span className="text-xs font-normal text-muted-foreground">
                      {session.provider} · {statusLabels[message.state]}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
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
                aria-label="Zgoda operatora"
                className="space-y-3 rounded-lg border p-4"
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
      <div className="shrink-0 px-5 pt-3 pb-2 lg:px-8">
        <form
          className="mx-auto max-w-3xl"
          onSubmit={event => {
            event.preventDefault();
            if (draft.trim() && canSend) onSend();
          }}
        >
          <label htmlFor="message-input" className="sr-only">
            Wiadomość
          </label>
          <div className="rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring/30">
            <Textarea
              id="message-input"
              placeholder="Napisz, czym chcesz się zająć…"
              value={draft}
              onChange={event => onDraft(event.target.value)}
              maxLength={32000}
              className="max-h-40 min-h-14 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center justify-between gap-3 px-1 pt-1">
              <span className="text-xs text-muted-foreground">
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
                  disabled={!draft.trim() || !canSend}
                  aria-label="Wyślij wiadomość"
                  title="Wyślij wiadomość"
                >
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}
