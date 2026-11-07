import { useState } from 'react';
import type {
  DecideDelegationInput,
  RespondApprovalInput,
  Session,
} from '@nesvo/contracts';
import {
  ArrowUpRight,
  CheckCheck,
  GitBranch,
  Inbox,
  ShieldCheck,
} from 'lucide-react';
import {
  compactPreview,
  reviewDate,
  reviewPreview,
  reviewStatusLabels,
  type Review,
} from '@/entities/review';
import { modeLabels, modelLabel, roleLabels } from '@/entities/session';
import {
  ReviewDecision,
  type ReviewDecisionProps,
} from '@/features/review-decision';
import { Button } from '@/shared/ui/button';
import { Label } from '@/shared/ui/label';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';

type Props = ReviewDecisionProps & {
  reviews: Review[];
  sessions: Session[];
  loading: boolean;
  error: string;
  operationEnabled: boolean;
  operationErrors: Record<string, string>;
  approvalPending: Record<string, boolean>;
  delegationPending: Record<string, boolean>;
  onApproval: (input: RespondApprovalInput) => void;
  onDelegation: (input: DecideDelegationInput) => void;
  onSession: (sessionId: string, targetId?: string) => void;
  onRefresh: () => void;
};

type Filter = 'pending' | 'history' | 'all';
type ActionRow =
  | { type: 'review'; review: Review; at: string; id: string }
  | {
      type: 'approval';
      session: Session;
      approval: Session['pendingApprovals'][number];
      at: string;
      id: string;
    }
  | {
      type: 'delegation';
      session: Session;
      delegation: Session['delegations'][number];
      at: string;
      id: string;
    };

function approvalPreview(approval: Session['pendingApprovals'][number]) {
  const fallback = compactPreview(approval.detail, 360);
  if (approval.kind !== 'file-change') return fallback;
  const headers = [...approval.detail.matchAll(/^(\{[^\n]+\}) ([^\n]+)$/gm)];
  if (headers.length === 0) return fallback;
  const directory = approval.directory
    ?.replaceAll('\\', '/')
    .replace(/\/$/, '');
  const relativePath = (path: string) => {
    const normalized = path.replaceAll('\\', '/');
    return directory && normalized.startsWith(`${directory}/`)
      ? normalized.slice(directory.length + 1)
      : normalized;
  };
  const changes: string[] = [];
  for (const header of headers) {
    try {
      const change: unknown = JSON.parse(header[1]!);
      if (!change || typeof change !== 'object' || !('type' in change))
        return fallback;
      const action =
        change.type === 'add'
          ? 'Zapis'
          : change.type === 'delete'
            ? 'Usunięcie'
            : change.type === 'update'
              ? 'Edycja'
              : '';
      if (!action) return fallback;
      const destination =
        'move_path' in change
          ? change.move_path
          : 'movePath' in change
            ? change.movePath
            : null;
      const source = relativePath(header[2]!.trim());
      changes.push(
        typeof destination === 'string'
          ? `Przeniesienie: ${source} → ${relativePath(destination)}`
          : `${action}: ${source}`,
      );
    } catch {
      return fallback;
    }
  }
  return compactPreview(changes.join(' · '), 360);
}

export function ReviewInbox({
  reviews,
  sessions,
  loading,
  error,
  operationEnabled,
  operationErrors,
  approvalPending,
  delegationPending,
  onApproval,
  onDelegation,
  onSession,
  onRefresh,
  ...decisionProps
}: Props) {
  const [filter, setFilter] = useState<Filter>('pending');
  const rows: ActionRow[] = reviews
    .filter(
      review =>
        filter === 'all' ||
        (filter === 'pending'
          ? review.status === 'pending'
          : review.status !== 'pending'),
    )
    .map(review => ({
      type: 'review',
      review,
      at: review.createdAt,
      id: review.id,
    }));
  if (filter !== 'history')
    for (const session of sessions) {
      if (session.status !== 'running' || !session.runId) continue;
      for (const approval of session.pendingApprovals)
        rows.push({
          type: 'approval',
          session,
          approval,
          at: session.updatedAt,
          id: `${session.id}/${session.runId}/${approval.id}`,
        });
      for (const delegation of session.delegations)
        if (
          delegation.status === 'pending' &&
          delegation.runId === session.runId
        )
          rows.push({
            type: 'delegation',
            session,
            delegation,
            at: session.updatedAt,
            id: `${session.id}/${session.runId}/${delegation.id}`,
          });
    }
  rows.sort(
    (left, right) =>
      right.at.localeCompare(left.at) || left.id.localeCompare(right.id),
  );
  const sessionLink = (sessionId: string, title: string, target: string) => (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto min-w-0 justify-start px-0 py-0 text-left text-sm font-medium whitespace-normal [overflow-wrap:anywhere]"
      aria-label={`Otwórz sesję: ${title}`}
      onClick={() => onSession(sessionId, target)}
    >
      {title}
      <ArrowUpRight className="size-3 shrink-0" />
    </Button>
  );
  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <section
        aria-label="Skrzynka odbioru"
        className="mx-auto max-w-4xl space-y-5 px-5 py-6 lg:px-8"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">
            {filter === 'history' ? 'Historia decyzji' : 'Do decyzji'}
          </h2>
          <div className="flex items-center gap-2">
            <Label
              htmlFor="inbox-filter"
              className="text-xs text-muted-foreground"
            >
              Widok
            </Label>
            <Select
              value={filter}
              onValueChange={value => {
                if (
                  value === 'pending' ||
                  value === 'history' ||
                  value === 'all'
                )
                  setFilter(value);
              }}
            >
              <SelectTrigger id="inbox-filter" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Do decyzji</SelectItem>
                <SelectItem value="history">Historia</SelectItem>
                <SelectItem value="all">Wszystkie</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {error && (
          <div className="space-y-2">
            <p
              role="alert"
              className="text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
            <Button size="sm" variant="outline" onClick={onRefresh}>
              Odśwież wyniki
            </Button>
          </div>
        )}
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            Wczytywanie wyników…
          </p>
        )}
        {rows.length > 0 ? (
          <div className="divide-y border-y">
            {rows.map(row => {
              if (row.type === 'review') {
                const { review } = row;
                const sessionTitle =
                  sessions.find(session => session.id === review.sessionId)
                    ?.title ?? review.title;
                return (
                  <article
                    key={`review/${row.id}`}
                    aria-label={`Odbiór wyniku: ${review.title}, wersja ${review.version}`}
                    className="space-y-3 px-1 py-5"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <CheckCheck className="size-3.5" />
                      <span>Odbiór wyniku</span>
                      <span>·</span>
                      <span>Wersja {review.version}</span>
                      <span>·</span>
                      <span>{reviewStatusLabels[review.status]}</span>
                    </div>
                    {sessionLink(
                      review.sessionId,
                      sessionTitle,
                      `review-${review.id}`,
                    )}
                    {review.title !== sessionTitle && (
                      <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
                        {review.title}
                      </h3>
                    )}
                    <p className="text-sm leading-relaxed [overflow-wrap:anywhere]">
                      {reviewPreview(review)}
                    </p>
                    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {roleLabels[review.role]} · {review.provider}
                      </span>
                      <span>
                        {review.diff.status === 'complete'
                          ? `Pliki w porównaniu: ${review.diff.files.length}`
                          : review.diff.status === 'not-applicable'
                            ? 'Podsumowanie analizy'
                            : 'Porównanie zmian niedostępne'}
                      </span>
                      <time dateTime={review.createdAt}>
                        {reviewDate(review.createdAt)}
                      </time>
                    </p>
                    {review.status === 'pending' ? (
                      <ReviewDecision review={review} {...decisionProps} />
                    ) : (
                      <>
                        {review.decision && (
                          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                            <p>
                              {review.decision.decision === 'accept'
                                ? 'Zaakceptowano tę wersję.'
                                : 'Odesłano tę wersję do poprawy.'}{' '}
                              <time dateTime={review.decision.at}>
                                {reviewDate(review.decision.at)}
                              </time>
                            </p>
                            {review.decision.feedback && (
                              <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                                {compactPreview(review.decision.feedback, 360)}
                              </p>
                            )}
                          </div>
                        )}
                        {decisionProps.decisionErrors[review.id] && (
                          <p
                            role="alert"
                            className="text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]"
                          >
                            {decisionProps.decisionErrors[review.id]}
                          </p>
                        )}
                      </>
                    )}
                  </article>
                );
              }
              const { session } = row;
              if (row.type === 'approval') {
                const { approval } = row;
                const deciding = !!approvalPending[row.id];
                const enabled = operationEnabled && !deciding;
                return (
                  <article
                    key={`approval/${row.id}`}
                    aria-label={`Zgoda na operację: ${session.title}`}
                    data-approval-id={approval.id}
                    className="space-y-3 px-1 py-5"
                  >
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <ShieldCheck className="size-3.5" />
                      {approval.kind === 'command'
                        ? 'Zgoda na polecenie'
                        : 'Zgoda na zmianę plików'}
                    </p>
                    {sessionLink(
                      session.id,
                      session.title,
                      `approval-${approval.id}`,
                    )}
                    <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
                      {approval.title}
                    </h3>
                    {approval.detail && (
                      <p className="text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                        {approvalPreview(approval)}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      Katalog pracy: {approval.directory ?? session.directory}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={!enabled}
                        onClick={() => {
                          if (session.runId)
                            onApproval({
                              sessionId: session.id,
                              runId: session.runId,
                              requestId: approval.id,
                              decision: 'accept',
                            });
                        }}
                      >
                        Zezwól jednorazowo
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!enabled}
                        onClick={() => {
                          if (session.runId)
                            onApproval({
                              sessionId: session.id,
                              runId: session.runId,
                              requestId: approval.id,
                              decision: 'decline',
                            });
                        }}
                      >
                        Odmów
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {deciding
                        ? 'Przekazywanie decyzji…'
                        : operationEnabled
                          ? 'Decyzja dotyczy tylko tej operacji. Pełne szczegóły są w sesji.'
                          : 'Połącz ponownie z hostem, aby podjąć decyzję.'}
                    </p>
                    {operationErrors[session.id] && (
                      <p
                        role="alert"
                        className="text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]"
                      >
                        {operationErrors[session.id]}
                      </p>
                    )}
                  </article>
                );
              }
              const { delegation } = row;
              const deciding = !!delegationPending[row.id];
              const enabled = operationEnabled && !deciding;
              return (
                <article
                  key={`delegation/${row.id}`}
                  aria-label={`Uruchomienie workera: ${delegation.title}`}
                  className="space-y-3 px-1 py-5"
                >
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <GitBranch className="size-3.5" />
                    Uruchomienie workera
                  </p>
                  {sessionLink(
                    session.id,
                    session.title,
                    `delegation-${delegation.id}`,
                  )}
                  <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
                    {delegation.title}
                  </h3>
                  <p className="text-sm leading-relaxed [overflow-wrap:anywhere]">
                    {compactPreview(delegation.task, 320)}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    Zakres: {delegation.scope}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {delegation.provider} · {modelLabel(delegation.model)} ·{' '}
                    {modeLabels[delegation.mode]}
                    <br />
                    Katalog względem sesji: {delegation.directory}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={!enabled}
                      onClick={() => {
                        if (session.runId)
                          onDelegation({
                            sessionId: session.id,
                            runId: session.runId,
                            delegationId: delegation.id,
                            decision: 'accept',
                          });
                      }}
                    >
                      Zatwierdź workera
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!enabled}
                      onClick={() => {
                        if (session.runId)
                          onDelegation({
                            sessionId: session.id,
                            runId: session.runId,
                            delegationId: delegation.id,
                            decision: 'decline',
                          });
                      }}
                    >
                      Odrzuć propozycję
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {deciding
                      ? 'Przekazywanie decyzji…'
                      : operationEnabled
                        ? 'Zgoda uruchamia tego workera w pokazanym zakresie i trybie.'
                        : 'Połącz ponownie z hostem, aby podjąć decyzję.'}
                  </p>
                  {operationErrors[session.id] && (
                    <p
                      role="alert"
                      className="text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]"
                    >
                      {operationErrors[session.id]}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          !loading &&
          !error && (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center">
              <Inbox className="size-7 text-muted-foreground" />
              <h3 className="text-lg font-medium">
                {filter === 'history'
                  ? 'Brak decyzji w historii'
                  : 'Nie ma teraz decyzji do podjęcia'}
              </h3>
              <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
                {filter === 'history'
                  ? 'Zapisane odbiory wyników i uwagi do poprawy pojawią się tutaj.'
                  : 'Tutaj pojawią się zgody na operacje, propozycje workerów i ukończone wyniki.'}
              </p>
            </div>
          )
        )}
      </section>
    </ScrollArea>
  );
}
