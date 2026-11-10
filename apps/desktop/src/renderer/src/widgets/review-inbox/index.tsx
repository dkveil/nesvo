import { useState } from 'react';
import type {
  DecideDelegationInput,
  RespondApprovalInput,
} from '@nesvo/contracts';
import { ArrowUpRight, Inbox } from 'lucide-react';
import {
  compactPreview,
  reviewDate,
  reviewPreview,
  reviewStatusLabels,
  type Review,
} from '@/entities/review';
import {
  directoryLabel,
  modeLabels,
  modelLabel,
  type Session,
} from '@/entities/session';
import type { Computer } from '@nesvo/contracts';
import { entityKey, hostKey } from '@/shared/lib/host-key';
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
  computers: Computer[];
  isOperationEnabled: (session: Pick<Session, 'hostId'>) => boolean;
  operationErrors: Record<string, string>;
  approvalPending: Record<string, boolean>;
  delegationPending: Record<string, boolean>;
  onApproval: (input: RespondApprovalInput, hostId: string) => void;
  onDelegation: (input: DecideDelegationInput, hostId: string) => void;
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
          ? 'Write'
          : change.type === 'delete'
            ? 'Delete'
            : change.type === 'update'
              ? 'Edit'
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
          ? `Move: ${source} → ${relativePath(destination)}`
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
  computers,
  isOperationEnabled,
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
      id: entityKey(review),
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
          id: `${entityKey(session)}/${session.runId}/${approval.id}`,
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
            id: `${entityKey(session)}/${session.runId}/${delegation.id}`,
          });
    }
  rows.sort(
    (left, right) =>
      right.at.localeCompare(left.at) || left.id.localeCompare(right.id),
  );
  const sessionLink = (sessionId: string, title: string, target: string) => (
    <button
      type="button"
      className="inline-flex max-w-full items-center gap-1.5 text-left text-sm font-medium text-foreground hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      aria-label={`Open session: ${title}`}
      onClick={() => onSession(sessionId, target)}
    >
      <span className="truncate">{title}</span>
      <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
  const directory = (path: string) => (
    <span
      className="truncate"
      title={path}
      aria-label={`Working directory: ${path}`}
    >
      {directoryLabel(path)}
    </span>
  );
  const rowClass =
    'grid grid-cols-1 items-start gap-x-5 gap-y-2 rounded-lg px-3 py-3 transition-colors duration-100 hover:bg-accent focus-within:bg-accent md:grid-cols-[minmax(0,1fr)_auto]';
  const actionClass = 'flex flex-wrap items-center gap-1.5 self-center';
  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <section
        aria-label="Inbox"
        className="mx-auto w-full max-w-4xl px-5 py-6 lg:px-8"
      >
        <div className="mb-3 flex items-center justify-between gap-3 px-3">
          <span className="text-xs text-muted-foreground tabular-nums">
            {rows.length}{' '}
            {filter === 'history'
              ? 'past decisions'
              : filter === 'all'
                ? 'items'
                : 'pending'}
          </span>
          <div className="flex items-center gap-2">
            <Label htmlFor="inbox-filter" className="sr-only">
              View
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
              <SelectTrigger
                id="inbox-filter"
                size="sm"
                className="h-7 w-28 border-transparent bg-transparent text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="history">History</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {error && (
          <div className="mb-4 flex flex-wrap items-center gap-3 px-3">
            <p
              role="alert"
              className="text-xs text-destructive [overflow-wrap:anywhere]"
            >
              {error}
            </p>
            <Button size="sm" variant="ghost" onClick={onRefresh}>
              Refresh results
            </Button>
          </div>
        )}
        {loading && (
          <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
            Loading results…
          </p>
        )}
        {filter !== 'history' &&
          decisionProps.blockedReason &&
          reviews.some(review => review.status === 'pending') && (
            <p className="mb-3 px-3 text-2xs text-muted-foreground">
              {decisionProps.blockedReason}
            </p>
          )}
        {filter !== 'history' &&
          !operationEnabled &&
          rows.some(row => row.type !== 'review') && (
            <p className="mb-3 px-3 text-2xs text-muted-foreground">
              Reconnect to respond to pending requests.
            </p>
          )}
        {rows.length > 0 ? (
          <div className="space-y-px">
            {rows.map(row => {
              if (row.type === 'review') {
                const { review } = row;
                const title =
                  sessions.find(
                    session =>
                      session.id === review.sessionId &&
                      session.hostId === review.hostId,
                  )?.title ?? review.title;
                return (
                  <article
                    key={`review/${row.id}`}
                    aria-label={`Review result: ${review.title}, version ${review.version}`}
                    data-host-id={review.hostId}
                    className={rowClass}
                  >
                    <div className="min-w-0 space-y-1">
                      {sessionLink(
                        hostKey(review.sessionId, review.hostId),
                        title,
                        `review-${review.id}`,
                      )}
                      {(review.hostId !== 'local' ||
                        computers.length > 1 ||
                        !isOperationEnabled({ hostId: review.hostId })) && (
                        <p className="text-2xs text-muted-foreground">
                          {computers.find(item => item.id === review.hostId)
                            ?.name ?? review.hostId}
                          {!isOperationEnabled({ hostId: review.hostId })
                            ? ' · Offline snapshot'
                            : ''}
                        </p>
                      )}
                      <p className="line-clamp-2 text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
                        {reviewPreview(review)}
                      </p>
                      <p className="flex flex-wrap gap-x-2 gap-y-1 text-2xs leading-4 text-muted-foreground">
                        <span>
                          Result · v{review.version} ·{' '}
                          {reviewStatusLabels[review.status]}
                        </span>
                        {review.diff.status === 'unavailable' && (
                          <span>· Diff unavailable</span>
                        )}
                        <time dateTime={review.createdAt}>
                          {reviewDate(review.createdAt)}
                        </time>
                      </p>
                      {review.decision?.feedback && (
                        <p
                          className="line-clamp-1 text-2xs text-muted-foreground"
                          title={review.decision.feedback}
                        >
                          {compactPreview(review.decision.feedback, 200)}
                        </p>
                      )}
                    </div>
                    {review.status === 'pending' ? (
                      <ReviewDecision
                        compact
                        review={review}
                        {...decisionProps}
                      />
                    ) : (
                      decisionProps.decisionErrors[entityKey(review)] && (
                        <p
                          role="alert"
                          className="col-span-full text-xs text-destructive [overflow-wrap:anywhere]"
                        >
                          {decisionProps.decisionErrors[entityKey(review)]}
                        </p>
                      )
                    )}
                  </article>
                );
              }
              const { session } = row;
              const computerName =
                computers.find(item => item.id === session.hostId)?.name ??
                session.hostId;
              if (row.type === 'approval') {
                const { approval } = row;
                const deciding = !!approvalPending[row.id];
                const enabled =
                  operationEnabled && isOperationEnabled(session) && !deciding;
                const preview = approvalPreview(approval) || approval.title;
                return (
                  <article
                    key={`approval/${row.id}`}
                    aria-label={`Operation approval: ${session.title}`}
                    data-approval-id={approval.id}
                    data-host-id={session.hostId}
                    className={rowClass}
                  >
                    <div className="min-w-0 space-y-1">
                      {sessionLink(
                        entityKey(session),
                        session.title,
                        `approval-${approval.id}`,
                      )}
                      {(session.hostId !== 'local' ||
                        computers.length > 1 ||
                        !isOperationEnabled(session)) && (
                        <p className="text-2xs text-muted-foreground">
                          {computerName}
                          {!isOperationEnabled(session)
                            ? ' · Offline snapshot'
                            : ''}
                        </p>
                      )}
                      <p
                        className="line-clamp-2 text-[13px] leading-5 [overflow-wrap:anywhere]"
                        title={`${approval.title}\n${approval.detail}`}
                      >
                        {preview}
                      </p>
                      <p className="flex items-center gap-2 text-2xs leading-4 text-muted-foreground">
                        <span className="shrink-0">
                          {approval.kind === 'command'
                            ? 'Command approval'
                            : 'File approval'}{' '}
                          · {session.provider}
                        </span>
                        <span>·</span>
                        {directory(approval.directory ?? session.directory)}
                      </p>
                    </div>
                    <div className={actionClass}>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-7 px-2.5 text-[13px] font-normal"
                        disabled={!enabled}
                        onClick={() => {
                          if (session.runId)
                            onApproval(
                              {
                                sessionId: session.id,
                                runId: session.runId,
                                requestId: approval.id,
                                decision: 'accept',
                              },
                              session.hostId,
                            );
                        }}
                      >
                        Allow once
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[13px] font-normal text-muted-foreground"
                        disabled={!enabled}
                        onClick={() => {
                          if (session.runId)
                            onApproval(
                              {
                                sessionId: session.id,
                                runId: session.runId,
                                requestId: approval.id,
                                decision: 'decline',
                              },
                              session.hostId,
                            );
                        }}
                      >
                        Deny
                      </Button>
                    </div>
                    {deciding && (
                      <p
                        role="status"
                        className="col-span-full text-2xs text-muted-foreground"
                      >
                        Sending decision…
                      </p>
                    )}
                    {operationErrors[entityKey(session)] && (
                      <p
                        role="alert"
                        className="col-span-full text-xs text-destructive [overflow-wrap:anywhere]"
                      >
                        {operationErrors[entityKey(session)]}
                      </p>
                    )}
                  </article>
                );
              }
              const { delegation } = row;
              const deciding = !!delegationPending[row.id];
              const enabled =
                operationEnabled && isOperationEnabled(session) && !deciding;
              return (
                <article
                  key={`delegation/${row.id}`}
                  aria-label={`Start worker: ${delegation.title}`}
                  data-host-id={session.hostId}
                  className={rowClass}
                >
                  <div className="min-w-0 space-y-1">
                    {sessionLink(
                      entityKey(session),
                      session.title,
                      `delegation-${delegation.id}`,
                    )}
                    {(session.hostId !== 'local' ||
                      computers.length > 1 ||
                      !isOperationEnabled(session)) && (
                      <p className="text-2xs text-muted-foreground">
                        {computerName}
                        {!isOperationEnabled(session)
                          ? ' · Offline snapshot'
                          : ''}
                      </p>
                    )}
                    <p
                      className="line-clamp-2 text-[13px] leading-5 [overflow-wrap:anywhere]"
                      title={delegation.task}
                    >
                      {delegation.title}: {compactPreview(delegation.task, 180)}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs leading-4 text-muted-foreground">
                      <span>
                        Worker · {delegation.provider} ·{' '}
                        {modelLabel(delegation.model)} ·{' '}
                        {modeLabels[delegation.mode]}
                      </span>
                      <span
                        title={delegation.scope}
                        aria-label={`Scope: ${delegation.scope}`}
                        className="max-w-40 truncate"
                      >
                        {delegation.scope}
                      </span>
                      {directory(delegation.directory)}
                    </p>
                  </div>
                  <div className={actionClass}>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-[13px] font-normal"
                      disabled={!enabled}
                      onClick={() => {
                        if (session.runId)
                          onDelegation(
                            {
                              sessionId: session.id,
                              runId: session.runId,
                              delegationId: delegation.id,
                              decision: 'accept',
                            },
                            session.hostId,
                          );
                      }}
                    >
                      Approve worker
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[13px] font-normal text-muted-foreground"
                      disabled={!enabled}
                      onClick={() => {
                        if (session.runId)
                          onDelegation(
                            {
                              sessionId: session.id,
                              runId: session.runId,
                              delegationId: delegation.id,
                              decision: 'decline',
                            },
                            session.hostId,
                          );
                      }}
                    >
                      Decline
                    </Button>
                  </div>
                  {deciding && (
                    <p
                      role="status"
                      className="col-span-full text-2xs text-muted-foreground"
                    >
                      Sending decision…
                    </p>
                  )}
                  {operationErrors[entityKey(session)] && (
                    <p
                      role="alert"
                      className="col-span-full text-xs text-destructive [overflow-wrap:anywhere]"
                    >
                      {operationErrors[entityKey(session)]}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          !loading &&
          !error && (
            <div className="flex min-h-80 flex-col items-center justify-center gap-2 text-center">
              <span className="mb-2 flex size-10 items-center justify-center rounded-xl border bg-card text-muted-foreground">
                <Inbox className="size-4.5" aria-hidden="true" />
              </span>
              <h2 className="text-[15px] font-semibold tracking-tight">
                {filter === 'history'
                  ? 'No past decisions'
                  : 'You are all caught up'}
              </h2>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                {filter === 'history'
                  ? 'Decisions and feedback will appear here.'
                  : 'Requests and completed results will appear here.'}
              </p>
            </div>
          )
        )}
      </section>
    </ScrollArea>
  );
}
