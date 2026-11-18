import { useState, type ComponentProps, type ReactNode } from 'react';
import {
  latestStageReport,
  pendingStageQuestion,
  routesToInbox,
  type DecisionRoute,
  type PullRequestReference,
  type GateRuleProposal,
  type DecideDelegationInput,
  type DecideSessionParentInput,
  type RespondApprovalInput,
  type StageQuestionRecord,
  type StageReportRecord,
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
  approvalKindLabels,
  directoryLabel,
  modeLabel,
  modelLabel,
  type Session,
} from '@/entities/session';
import { ApprovalActions } from '@/features/session-mode/approval-actions';
import type { Computer } from '@nesvo/contracts';
import { entityKey, hostKey } from '@/shared/lib/host-key';
import type { ScheduledJob } from '@/entities/scheduled-job';
import {
  ReviewDecision,
  type ReviewDecisionProps,
} from '@/features/review-decision';
import { Button } from '@/shared/ui/button';
import { EmptyState } from '@/shared/ui/empty-state';
import { Label } from '@/shared/ui/label';
import { ListRow } from '@/shared/ui/list-row';
import { ScrollArea } from '@/shared/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { Toast, ToastRegion } from '@/shared/ui/toast';
import { undoGateRule } from '@/features/gate-rules/undo-gate-rule';
import { errorDetail } from '@/entities/session';
import { GateRuleRow } from './gate-rule-row';
import { useInboxGateRules } from './use-inbox-gate-rules';
import {
  PlanDecision,
  QuestionAnswer,
  type StageActions,
} from '@/widgets/session-stages';
import {
  InboxRuleDecisions,
  InboxRuleSummary,
  inboxItemKey,
  inboxRuleMeta,
  type HostedInboxItem,
  type InboxItemDecision,
} from '@/features/inbox-rules';

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
  parentPending: Record<string, boolean>;
  onParent: (input: DecideSessionParentInput, hostId: string) => void;
  onApproval: (input: RespondApprovalInput, hostId: string) => void;
  onDelegation: (input: DecideDelegationInput, hostId: string) => void;
  onSession: (sessionId: string, targetId?: string) => void;
  onRefresh: () => void;
  automations: ScheduledJob[];
  automationPending: Record<string, boolean>;
  automationErrors: Record<string, string>;
  onAutomation: (job: ScheduledJob) => void;
  onAutomationDecision: (job: ScheduledJob, decision: 'start' | 'skip') => void;
  originLabel?: (review: Review) => string;
  notice?: ReactNode;
  lessons?: ReactNode;
  stages: StageActions;
  ruleItems: HostedInboxItem[];
  rulePending: Record<string, boolean>;
  ruleErrors: Record<string, string>;
  onRuleDecision: (item: HostedInboxItem, decision: InboxItemDecision) => void;
  onRuleOpenChanges: (item: HostedInboxItem) => void;
  onRuleOpenPullRequest: (
    item: HostedInboxItem,
    reference: PullRequestReference,
  ) => void;
  routeOf: (session: Session) => DecisionRoute;
};

type Filter = 'pending' | 'history' | 'all';

type ActionRow =
  | {
      type: 'gate-rule-proposal';
      row: GateRuleProposal;
      hostId: string;
      at: string;
      id: string;
    }
  | { type: 'review'; review: Review; at: string; id: string }
  | { type: 'rule'; item: HostedInboxItem; at: string; id: string }
  | { type: 'automation'; job: ScheduledJob; at: string; id: string }
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
    }
  | {
      type: 'parent';
      session: Session;
      request: NonNullable<Session['parentRequest']>;
      at: string;
      id: string;
    }
  | {
      type: 'plan';
      session: Session;
      plan: NonNullable<Session['plan']>;
      at: string;
      id: string;
    }
  | {
      type: 'question';
      session: Session;
      record: StageQuestionRecord;
      at: string;
      id: string;
    }
  | {
      type: 'report';
      session: Session;
      record: StageReportRecord;
      at: string;
      id: string;
    };

const ROW_COLUMNS = 'minmax(0,1fr) auto';

function FullText({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent variant="panel" className="whitespace-pre-wrap">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

type ActionItemProps = Omit<ComponentProps<'article'>, 'title'> & {
  openLabel?: string;
  title: string;
  onOpen?: () => void;
  location: string;
  summary: ReactNode;
  meta: ReactNode;
};

function ActionItem({
  title,
  onOpen,
  location,
  summary,
  meta,
  children,
  openLabel = `Open session: ${title}`,
  ...props
}: ActionItemProps) {
  return (
    <article {...props}>
      <ListRow density="block" columns={ROW_COLUMNS}>
        <div className="min-w-0 space-y-1">
          {onOpen ? (
            <Button
              variant="link"
              size="inline"
              className="max-w-full justify-start text-ui text-foreground"
              aria-label={openLabel}
              onClick={onOpen}
            >
              <span className="truncate">{title}</span>
              <ArrowUpRight className="size-3 text-muted-foreground" />
            </Button>
          ) : (
            <p className="text-ui font-medium [overflow-wrap:anywhere]">
              {title}
            </p>
          )}
          {location && (
            <p className="text-2xs text-muted-foreground">{location}</p>
          )}
          {summary}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
            {meta}
          </div>
        </div>
        {children}
      </ListRow>
    </article>
  );
}

function Directory({ path }: { path: string }) {
  return (
    <FullText text={path}>
      <span className="truncate" aria-label={`Working directory: ${path}`}>
        {directoryLabel(path)}
      </span>
    </FullText>
  );
}

function Decisions({
  accept,
  decline,
  enabled,
  onDecide,
}: {
  accept: string;
  decline: string;
  enabled: boolean;
  onDecide: (decision: 'accept' | 'decline') => void;
}) {
  return (
    <div className="col-start-2 row-start-1 flex flex-wrap items-center gap-1.5 self-center">
      <Button
        type="button"
        variant="secondary"
        disabled={!enabled}
        onClick={() => onDecide('accept')}
      >
        {accept}
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={!enabled}
        onClick={() => onDecide('decline')}
      >
        {decline}
      </Button>
    </div>
  );
}

function OperationStatus({
  deciding,
  error,
}: {
  deciding: boolean;
  error: string | undefined;
}) {
  return (
    <>
      {deciding && (
        <StatusMessage tone="loading" className="col-span-full">
          Sending decision…
        </StatusMessage>
      )}
      {error && (
        <StatusMessage tone="error" className="col-span-full">
          {error}
        </StatusMessage>
      )}
    </>
  );
}

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
  parentPending,
  onParent,
  onApproval,
  onDelegation,
  onSession,
  onRefresh,
  automations,
  automationPending,
  automationErrors,
  onAutomation,
  onAutomationDecision,
  originLabel,
  notice,
  lessons,
  stages,
  ruleItems,
  rulePending,
  ruleErrors,
  onRuleDecision,
  onRuleOpenChanges,
  onRuleOpenPullRequest,
  routeOf,
  ...decisionProps
}: Props) {
  const [filter, setFilter] = useState<Filter>('pending');
  const heldSessions = new Set(
    ruleItems
      .filter(item => item.status === 'pending' && item.binding === 'provider')
      .map(item => `${item.hostId}/${item.sessionId}`),
  );
  const inInbox = (session: Session) => routesToInbox(routeOf(session));
  const gateRules = useInboxGateRules(computers);
  const [gateToast, setGateToast] = useState<{
    row: GateRuleProposal;
    hostId: string;
  } | null>(null);
  const [undoError, setUndoError] = useState('');
  const [undoPending, setUndoPending] = useState(false);
  const undoSaved = async () => {
    if (!gateToast?.row.changeId) return;
    setUndoPending(true);
    setUndoError('');
    try {
      await undoGateRule(gateToast.hostId, {
        conversationId: gateToast.row.sessionId,
        changeId: gateToast.row.changeId,
      });
      setGateToast(null);
    } catch (reason) {
      setUndoError(errorDetail(reason));
    } finally {
      setUndoPending(false);
    }
  };
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
    for (const session of sessions)
      if (session.parentRequest)
        rows.push({
          type: 'parent',
          session,
          request: session.parentRequest,
          at: session.parentRequest.requestedAt,
          id: `${entityKey(session)}/${session.parentRequest.id}`,
        });
  for (const item of ruleItems)
    if (
      (routesToInbox(item.route) ||
        (item.binding === 'external' &&
          !sessions.some(
            session =>
              session.id === item.parentId &&
              session.hostId === item.hostId &&
              !session.archivedAt,
          ))) &&
      (filter === 'all' ||
        (filter === 'pending'
          ? item.status === 'pending'
          : item.status !== 'pending'))
    )
      rows.push({
        type: 'rule',
        item,
        at: item.decidedAt ?? item.createdAt,
        id: inboxItemKey(item),
      });
  if (filter !== 'history')
    for (const session of sessions) {
      if (session.status !== 'running' || !session.runId) continue;
      if (!inInbox(session)) continue;
      if (heldSessions.has(`${session.hostId}/${session.id}`)) continue;
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
  if (filter !== 'history')
    for (const session of sessions) {
      const key = entityKey(session);
      if (!inInbox(session)) continue;
      if (session.plan?.status === 'plan-ready')
        rows.push({
          type: 'plan',
          session,
          plan: session.plan,
          at: session.plan.readyAt ?? session.updatedAt,
          id: `${key}/${session.plan.id}`,
        });
      const question = pendingStageQuestion(session);
      if (question)
        rows.push({
          type: 'question',
          session,
          record: question,
          at: question.at,
          id: `${key}/${question.id}`,
        });
      const report = latestStageReport(session);
      if (
        report &&
        report.runId === session.runId &&
        session.status !== 'running' &&
        session.status !== 'stopping'
      )
        rows.push({
          type: 'report',
          session,
          record: report,
          at: report.at,
          id: `${key}/${report.id}`,
        });
    }
  if (filter !== 'history')
    for (const job of automations)
      if (job.pendingStart)
        rows.push({
          type: 'automation',
          job,
          at: job.pendingStart.at,
          id: `${entityKey(job)}/${job.pendingStart.id}`,
        });
  if (filter !== 'history')
    for (const { hostId, proposal } of gateRules.rows)
      rows.push({
        type: 'gate-rule-proposal',
        row: proposal,
        hostId,
        at: proposal.createdAt,
        id: hostKey(proposal.id, hostId),
      });
  rows.sort(
    (left, right) =>
      right.at.localeCompare(left.at) || left.id.localeCompare(right.id),
  );
  const location = (hostId: string) => {
    const online = isOperationEnabled({ hostId });
    if (hostId === 'local' && computers.length <= 1 && online) return '';
    const name = computers.find(item => item.id === hostId)?.name ?? hostId;
    return online ? name : `${name} · Offline snapshot`;
  };
  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <section
        aria-label="Inbox"
        className="mx-auto w-full max-w-4xl px-5 py-6 lg:px-8"
      >
        <div className="mb-3 flex items-center justify-between gap-3 px-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {rows.length}{' '}
            {filter === 'history'
              ? 'past decisions'
              : filter === 'all'
                ? 'items'
                : 'pending'}
          </span>
          <Label htmlFor="inbox-filter" className="sr-only">
            View
          </Label>
          <Select
            value={filter}
            onValueChange={value => {
              if (value === 'pending' || value === 'history' || value === 'all')
                setFilter(value);
            }}
          >
            <SelectTrigger id="inbox-filter" variant="ghost" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="history">History</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {notice}
        {filter !== 'history' && lessons}
        {filter !== 'history' &&
          gateRules.errors.map(message => (
            <StatusMessage key={message} className="mb-2 px-2" tone="error">
              {message}
            </StatusMessage>
          ))}
        {gateToast && (
          <ToastRegion>
            <Toast
              tone={undoError ? 'error' : 'success'}
              title={undoError || 'Gate rule saved'}
              description={gateToast.row.error}
              action={
                gateToast.row.changeId
                  ? {
                      label: 'Undo',
                      onClick: () => void undoSaved(),
                      disabled: undoPending,
                    }
                  : undefined
              }
              onDismiss={() => setGateToast(null)}
            />
          </ToastRegion>
        )}
        {error && (
          <div className="mb-4 flex flex-wrap items-center gap-3 px-2">
            <StatusMessage tone="error">{error}</StatusMessage>
            <Button variant="ghost" onClick={onRefresh}>
              Refresh results
            </Button>
          </div>
        )}
        {loading && (
          <StatusMessage tone="loading" className="px-2 py-3">
            Loading results…
          </StatusMessage>
        )}
        {filter !== 'history' &&
          decisionProps.blockedReason &&
          reviews.some(review => review.status === 'pending') && (
            <StatusMessage className="mb-3 px-2">
              {decisionProps.blockedReason}
            </StatusMessage>
          )}
        {filter !== 'history' &&
          !operationEnabled &&
          rows.some(
            row =>
              row.type === 'approval' ||
              row.type === 'delegation' ||
              row.type === 'parent' ||
              row.type === 'plan' ||
              row.type === 'question' ||
              row.type === 'automation',
          ) && (
            <StatusMessage className="mb-3 px-2">
              Reconnect to respond to pending requests.
            </StatusMessage>
          )}
        {rows.length > 0 ? (
          <div className="space-y-px">
            {rows.map(row => {
              if (row.type === 'gate-rule-proposal') {
                const title =
                  sessions.find(
                    session =>
                      session.hostId === row.hostId &&
                      session.id === row.row.taskSessionId,
                  )?.title ?? row.row.workflow;
                return (
                  <GateRuleRow
                    key={row.id}
                    row={row.row}
                    hostId={row.hostId}
                    title={title}
                    location={location(row.hostId)}
                    onSession={onSession}
                    onSaved={(saved, hostId) => {
                      setUndoError('');
                      setGateToast({ row: saved, hostId });
                    }}
                  />
                );
              }
              if (row.type === 'review') {
                const { review } = row;
                const origin = originLabel?.(review) ?? '';
                const title =
                  sessions.find(
                    session =>
                      session.id === review.sessionId &&
                      session.hostId === review.hostId,
                  )?.title ?? review.title;
                const reviewError =
                  decisionProps.decisionErrors[entityKey(review)];
                return (
                  <ActionItem
                    key={`review/${row.id}`}
                    aria-label={`Review result: ${review.title}, version ${review.version}`}
                    data-host-id={review.hostId}
                    title={title}
                    onOpen={() =>
                      onSession(
                        hostKey(review.sessionId, review.hostId),
                        `review-${review.id}`,
                      )
                    }
                    location={location(review.hostId)}
                    summary={
                      <>
                        <p className="line-clamp-2 text-ui text-muted-foreground [overflow-wrap:anywhere]">
                          {reviewPreview(review)}
                        </p>
                        {review.decision?.feedback && (
                          <FullText text={review.decision.feedback}>
                            <p className="line-clamp-1 text-2xs text-muted-foreground">
                              {compactPreview(review.decision.feedback, 200)}
                            </p>
                          </FullText>
                        )}
                      </>
                    }
                    meta={
                      <>
                        {origin && (
                          <span
                            data-origin="automation"
                            className="font-medium text-foreground/80"
                          >
                            {origin} ·
                          </span>
                        )}
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
                      </>
                    }
                  >
                    {review.status === 'pending' ? (
                      <ReviewDecision
                        compact
                        review={review}
                        {...decisionProps}
                      />
                    ) : (
                      reviewError && (
                        <StatusMessage tone="error" className="col-span-full">
                          {reviewError}
                        </StatusMessage>
                      )
                    )}
                  </ActionItem>
                );
              }
              if (row.type === 'rule') {
                const { item } = row;
                const key = inboxItemKey(item);
                const subjectSession = sessions.find(
                  session =>
                    session.id === item.sessionId &&
                    session.hostId === item.hostId,
                );
                return (
                  <ActionItem
                    key={`rule/${row.id}`}
                    aria-label={
                      item.binding === 'external'
                        ? `External Inbox item: ${item.subject}`
                        : `Inbox rule ${item.rule.name}: ${item.sessionTitle}`
                    }
                    data-host-id={item.hostId}
                    data-inbox-rule={item.rule?.name}
                    data-inbox-type={
                      item.binding === 'external' ? 'external' : undefined
                    }
                    title={
                      item.binding === 'external'
                        ? item.subject
                        : (subjectSession?.title ?? item.sessionTitle)
                    }
                    openLabel={
                      item.sessionId
                        ? `Open session: ${subjectSession?.title ?? item.sessionTitle}`
                        : undefined
                    }
                    onOpen={
                      item.sessionId || item.presentation.pullRequest
                        ? () =>
                            item.sessionId
                              ? onSession(hostKey(item.sessionId, item.hostId))
                              : item.presentation.pullRequest &&
                                onRuleOpenPullRequest(
                                  item,
                                  item.presentation.pullRequest,
                                )
                        : undefined
                    }
                    location={location(item.hostId)}
                    summary={
                      <InboxRuleSummary
                        item={item}
                        onOpenChanges={
                          item.sessionId
                            ? () => onRuleOpenChanges(item)
                            : undefined
                        }
                        onOpenPullRequest={reference =>
                          onRuleOpenPullRequest(item, reference)
                        }
                      />
                    }
                    meta={
                      <>
                        <span>{inboxRuleMeta(item)}</span>
                        {item.binding === 'external' && item.sessionId && (
                          <span>
                            {subjectSession?.title ?? item.sessionTitle}
                          </span>
                        )}
                        <time dateTime={row.at}>{reviewDate(row.at)}</time>
                      </>
                    }
                  >
                    <InboxRuleDecisions
                      item={item}
                      enabled={isOperationEnabled(item)}
                      deciding={!!rulePending[key]}
                      error={ruleErrors[key]}
                      onDecide={decision => onRuleDecision(item, decision)}
                    />
                  </ActionItem>
                );
              }
              if (row.type === 'automation') {
                const { job, at } = row;
                const key = entityKey(job);
                const deciding = !!automationPending[key];
                return (
                  <ActionItem
                    key={`automation/${row.id}`}
                    aria-label={`Automation start: ${job.name}`}
                    data-host-id={job.hostId}
                    title={job.name}
                    openLabel={`Open automation: ${job.name}`}
                    onOpen={() => onAutomation(job)}
                    location={location(job.hostId)}
                    summary={
                      <p className="text-ui text-muted-foreground">
                        The check output changed since the last run.
                      </p>
                    }
                    meta={
                      <>
                        <span>Automation start</span>
                        <time dateTime={at}>{reviewDate(at)}</time>
                      </>
                    }
                  >
                    <Decisions
                      accept="Start"
                      decline="Skip"
                      enabled={isOperationEnabled(job) && !deciding}
                      onDecide={decision =>
                        onAutomationDecision(
                          job,
                          decision === 'accept' ? 'start' : 'skip',
                        )
                      }
                    />
                    <OperationStatus
                      deciding={deciding}
                      error={automationErrors[key]}
                    />
                  </ActionItem>
                );
              }
              const { session } = row;
              const operationError = operationErrors[entityKey(session)];
              const parentTitle = session.parentId
                ? sessions.find(
                    item =>
                      item.id === session.parentId &&
                      item.hostId === session.hostId,
                  )?.title
                : undefined;
              const from = parentTitle ? ` · for ${parentTitle}` : '';
              if (row.type === 'plan') {
                const { plan } = row;
                return (
                  <ActionItem
                    key={`plan/${row.id}`}
                    aria-label={`Plan: ${session.title}`}
                    data-host-id={session.hostId}
                    title={session.title}
                    onOpen={() =>
                      onSession(entityKey(session), `plan-${plan.id}`)
                    }
                    location={location(session.hostId)}
                    summary={
                      <NativeDisclosure
                        title={
                          <span className="text-ui text-foreground">
                            {compactPreview(
                              (plan.text ?? '')
                                .replace(/^#{1,6}\s.*$/gm, '')
                                .replace(/[*_`]/g, ''),
                              180,
                            ) || 'Empty plan'}
                          </span>
                        }
                        triggerLabel="Show the full plan"
                        className="-ml-2"
                      >
                        <p className="max-h-80 overflow-y-auto pr-2 text-ui whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
                          {plan.text}
                        </p>
                      </NativeDisclosure>
                    }
                    meta={
                      <>
                        <span>
                          {plan.round > 0 ? `Plan ${plan.round + 1}` : 'Plan'} ·{' '}
                          {session.provider} · then{' '}
                          {modeLabel(session.provider, plan.targetMode)}
                          {from}
                        </span>
                        <time dateTime={row.at}>{reviewDate(row.at)}</time>
                      </>
                    }
                  >
                    <PlanDecision session={session} actions={stages} compact />
                  </ActionItem>
                );
              }
              if (row.type === 'question') {
                const { record } = row;
                return (
                  <ActionItem
                    key={`question/${row.id}`}
                    aria-label={`Question: ${session.title}`}
                    data-host-id={session.hostId}
                    title={session.title}
                    onOpen={() =>
                      onSession(entityKey(session), `question-${record.id}`)
                    }
                    location={location(session.hostId)}
                    summary={
                      <>
                        <p className="line-clamp-2 text-ui [overflow-wrap:anywhere]">
                          {record.question.question}
                        </p>
                        {record.question.recommendation && (
                          <FullText text={record.question.recommendation}>
                            <p className="line-clamp-1 text-2xs text-muted-foreground">
                              Recommendation:{' '}
                              {compactPreview(
                                record.question.recommendation,
                                200,
                              )}
                            </p>
                          </FullText>
                        )}
                      </>
                    }
                    meta={
                      <>
                        <span>
                          {record.question.kind === 'product'
                            ? 'Product question'
                            : 'Technical question'}{' '}
                          · {session.provider}
                          {from}
                        </span>
                        <time dateTime={row.at}>{reviewDate(row.at)}</time>
                      </>
                    }
                  >
                    <QuestionAnswer
                      session={session}
                      record={record}
                      actions={stages}
                      compact
                    />
                  </ActionItem>
                );
              }
              if (row.type === 'report') {
                const { report } = row.record;
                return (
                  <ActionItem
                    key={`report/${row.id}`}
                    aria-label={`Report: ${session.title}`}
                    data-host-id={session.hostId}
                    title={session.title}
                    onOpen={() =>
                      onSession(entityKey(session), `stage-${row.record.id}`)
                    }
                    location={location(session.hostId)}
                    summary={
                      <FullText text={report.summary}>
                        <p className="line-clamp-2 text-ui [overflow-wrap:anywhere]">
                          {report.summary}
                        </p>
                      </FullText>
                    }
                    meta={
                      <>
                        <span>
                          Report · {report.status === 'ok' ? 'OK' : 'Failed'}
                          {report.links.length
                            ? ` · ${report.links.length} ${report.links.length === 1 ? 'link' : 'links'}`
                            : ''}
                          {from}
                        </span>
                        <time dateTime={row.at}>{reviewDate(row.at)}</time>
                      </>
                    }
                  />
                );
              }
              if (row.type === 'parent') {
                const { request } = row;
                const deciding = !!parentPending[row.id];
                return (
                  <ActionItem
                    key={`parent/${row.id}`}
                    aria-label={`Join coordinator: ${session.title}`}
                    data-host-id={session.hostId}
                    title={session.title}
                    onOpen={() => onSession(entityKey(session))}
                    location={location(session.hostId)}
                    summary={
                      <p className="line-clamp-2 text-ui [overflow-wrap:anywhere]">
                        {request.parentTitle} asks to coordinate this session.
                      </p>
                    }
                    meta={
                      <>
                        <span>Coordinator request</span>
                        <time dateTime={request.requestedAt}>
                          {reviewDate(request.requestedAt)}
                        </time>
                      </>
                    }
                  >
                    <Decisions
                      accept="Allow"
                      decline="Decline"
                      enabled={
                        operationEnabled &&
                        isOperationEnabled(session) &&
                        !deciding
                      }
                      onDecide={decision =>
                        onParent(
                          {
                            sessionId: session.id,
                            requestId: request.id,
                            decision,
                          },
                          session.hostId,
                        )
                      }
                    />
                    <OperationStatus
                      deciding={deciding}
                      error={operationError}
                    />
                  </ActionItem>
                );
              }
              if (row.type === 'approval') {
                const { approval } = row;
                const deciding = !!approvalPending[row.id];
                const enabled =
                  operationEnabled && isOperationEnabled(session) && !deciding;
                return (
                  <ActionItem
                    key={`approval/${row.id}`}
                    aria-label={`Operation approval: ${session.title}`}
                    data-approval-id={approval.id}
                    data-host-id={session.hostId}
                    title={session.title}
                    onOpen={() =>
                      onSession(entityKey(session), `approval-${approval.id}`)
                    }
                    location={location(session.hostId)}
                    summary={
                      <FullText text={`${approval.title}\n${approval.detail}`}>
                        <p className="line-clamp-2 text-ui [overflow-wrap:anywhere]">
                          {approvalPreview(approval) || approval.title}
                        </p>
                      </FullText>
                    }
                    meta={
                      <>
                        <span className="shrink-0">
                          {approvalKindLabels[approval.kind]} ·{' '}
                          {session.provider}
                        </span>
                        <span>·</span>
                        <Directory
                          path={approval.directory ?? session.directory}
                        />
                      </>
                    }
                  >
                    <ApprovalActions
                      approval={approval}
                      sessionId={session.id}
                      runId={session.runId ?? ''}
                      hostId={session.hostId}
                      enabled={enabled}
                      onDecide={decision => {
                        if (session.runId)
                          onApproval(
                            {
                              sessionId: session.id,
                              runId: session.runId,
                              requestId: approval.id,
                              ...decision,
                            },
                            session.hostId,
                          );
                      }}
                    />
                    <OperationStatus
                      deciding={deciding}
                      error={operationError}
                    />
                  </ActionItem>
                );
              }
              const { delegation } = row;
              const deciding = !!delegationPending[row.id];
              const enabled =
                operationEnabled && isOperationEnabled(session) && !deciding;
              return (
                <ActionItem
                  key={`delegation/${row.id}`}
                  aria-label={`Start worker: ${delegation.title}`}
                  data-host-id={session.hostId}
                  title={session.title}
                  onOpen={() =>
                    onSession(entityKey(session), `delegation-${delegation.id}`)
                  }
                  location={location(session.hostId)}
                  summary={
                    <FullText text={delegation.task}>
                      <p className="line-clamp-2 text-ui [overflow-wrap:anywhere]">
                        {delegation.title}:{' '}
                        {compactPreview(delegation.task, 180)}
                      </p>
                    </FullText>
                  }
                  meta={
                    <>
                      <span>
                        Worker · {delegation.provider} ·{' '}
                        {modelLabel(delegation.model)} ·{' '}
                        {modeLabel(delegation.provider, delegation.mode)}
                      </span>
                      <FullText text={delegation.scope}>
                        <span
                          aria-label={`Scope: ${delegation.scope}`}
                          className="max-w-40 truncate"
                        >
                          {delegation.scope}
                        </span>
                      </FullText>
                      <Directory path={delegation.directory} />
                    </>
                  }
                >
                  <Decisions
                    accept="Approve worker"
                    decline="Decline"
                    enabled={enabled}
                    onDecide={decision => {
                      if (session.runId)
                        onDelegation(
                          {
                            sessionId: session.id,
                            runId: session.runId,
                            delegationId: delegation.id,
                            decision,
                          },
                          session.hostId,
                        );
                    }}
                  />
                  <OperationStatus deciding={deciding} error={operationError} />
                </ActionItem>
              );
            })}
          </div>
        ) : (
          !loading &&
          !error && (
            <EmptyState
              icon={Inbox}
              title={
                filter === 'history'
                  ? 'No past decisions'
                  : 'You are all caught up'
              }
              description={
                filter === 'history'
                  ? 'Decisions and feedback will appear here.'
                  : 'Requests and completed results will appear here.'
              }
            />
          )
        )}
      </section>
    </ScrollArea>
  );
}
