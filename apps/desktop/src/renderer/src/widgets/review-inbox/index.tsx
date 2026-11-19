import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import {
  pendingStageQuestion,
  pendingTurnQuestion,
  routesToInbox,
  type DecisionRoute,
  type PullRequestReference,
  type GateRuleProposal,
  type DecideDelegationInput,
  type DecideSessionParentInput,
  type RespondApprovalInput,
  type StageQuestionRecord,
} from '@nesvo/contracts';
import { ArrowUpRight, Ellipsis, Inbox, MessageSquareText } from 'lucide-react';
import type { ConfigurationInboxSubject, HostId } from '@nesvo/contracts';
import { ConfigurationChangeRow } from '@/features/configuration/change-row';
import { useConfigurationChanges } from '@/features/configuration/use-configuration-changes';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu';
import { IconButton } from '@/shared/ui/icon-button';
import { InboxAssistant } from './inbox-assistant';
import {
  compactPreview,
  reviewDate,
  reviewPreview,
  resultReason,
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
import {
  SteeringDecisionActions,
  type SteeringRequest,
} from '@/features/session-mode/steering-decision-actions';
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
import { ListRow } from '@/shared/ui/list-row';
import { DecisionRow } from '@/entities/review/decision-row';
import { ScrollArea } from '@/shared/ui/scroll-area';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import type { WorkflowRun, WorkflowStepRecord } from '@/entities/workflow';
import { WorkflowGateDecision } from './workflow-gate-decision';
import { StatusMessage } from '@/shared/ui/status-message';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/ui/tooltip';
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { undoGateRule } from '@/features/gate-rules/undo-gate-rule';
import { errorDetail } from '@/entities/session';
import { GateRuleRow } from './gate-rule-row';
import type { useInboxGateRules } from './use-inbox-gate-rules';
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

import { TurnQuestionReply } from '@/features/review-decision/turn-question-reply';
import { CoordinatorWait } from '@/widgets/delegations/coordinator-wait';

type Props = ReviewDecisionProps & {
  linkedItem?: { hostId: string; id: string } | null;
  onContinueCoordinator: (session: Session) => Promise<void>;
  reviews: Review[];
  workflowRuns: WorkflowRun[];
  workflowSteps: WorkflowStepRecord[];
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
  onDiff: (review: Review) => void;
  onReply: (
    session: Session,
    runId: string,
    text: string,
    messageId: string,
  ) => Promise<void>;
  onRefresh: () => void;
  automations: ScheduledJob[];
  automationPending: Record<string, boolean>;
  automationErrors: Record<string, string>;
  onAutomation: (job: ScheduledJob) => void;
  onAutomationDecision: (job: ScheduledJob, decision: 'start' | 'skip') => void;
  originLabel?: (review: Review) => string;
  notice?: ReactNode;
  lessons?: ReactNode;
  gateRules: ReturnType<typeof useInboxGateRules>;
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
  | { type: 'coordinator-wait'; session: Session; at: string; id: string }
  | {
      type: 'steering';
      session: Session;
      request: SteeringRequest;
      at: string;
      id: string;
    }
  | { type: 'review'; review: Review; at: string; id: string }
  | {
      type: 'turn-question';
      session: Session;
      question: NonNullable<ReturnType<typeof pendingTurnQuestion>>;
      at: string;
      id: string;
    }
  | {
      type: 'workflow-gate';
      run: WorkflowRun;
      step: WorkflowStepRecord;
      at: string;
      id: string;
    }
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
    };

type AssistantSelection = {
  hostId: HostId;
  subject: ConfigurationInboxSubject | null;
};

function assistantSubject(row: ActionRow): AssistantSelection | null {
  switch (row.type) {
    case 'rule':
      return {
        hostId: row.item.hostId,
        subject: { kind: 'rule', id: row.item.id },
      };
    case 'review':
      return {
        hostId: row.review.hostId,
        subject: { kind: 'review', id: row.review.id },
      };
    case 'automation':
      return {
        hostId: row.job.hostId,
        subject: { kind: 'automation', id: row.job.id },
      };
    case 'gate-rule-proposal':
      return {
        hostId: row.hostId,
        subject: { kind: 'gate-rule-proposal', id: row.row.id },
      };
    case 'workflow-gate':
      return {
        hostId: row.run.hostId,
        subject: { kind: 'workflow-gate', id: row.step.id, runId: row.run.id },
      };
    default: {
      const id =
        row.type === 'approval'
          ? row.approval.id
          : row.type === 'delegation'
            ? row.delegation.id
            : row.type === 'plan'
              ? row.plan.id
              : row.type === 'parent'
                ? row.request.id
                : row.type === 'question'
                  ? row.record.id
                  : row.type === 'turn-question'
                    ? row.question.messageId
                    : row.session.coordinatorWait?.runId;
      return id
        ? {
            hostId: row.session.hostId,
            subject: { kind: row.type, id, sessionId: row.session.id },
          }
        : null;
    }
  }
}

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
  typeLabel?: string;
  why?: string;
  summary: ReactNode;
  meta: ReactNode;
};

function ActionItem({
  title,
  onOpen,
  location,
  typeLabel,
  why,
  summary,
  meta,
  children,
  openLabel = `Open session: ${title}`,
  ...props
}: ActionItemProps) {
  return (
    <article {...props} className="@container/inbox-item">
      <DecisionRow
        className="@max-[520px]/inbox-item:[&>div]:flex! @max-[520px]/inbox-item:[&>div]:flex-col @max-[520px]/inbox-item:[&>div]:items-stretch! @max-[520px]/inbox-item:[&_[data-inbox-actions]]:justify-start!"
        heading={
          <>
            {typeLabel && (
              <span className="font-medium text-muted-foreground">
                {typeLabel}
              </span>
            )}
            {onOpen ? (
              <Button
                variant="link"
                size="inline"
                className="min-w-0 max-w-full justify-start text-ui text-foreground"
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
              <span className="text-muted-foreground">{location}</span>
            )}
          </>
        }
        details={
          <>
            {why && (
              <p
                className="line-clamp-1 text-2xs font-medium text-muted-foreground"
                title={why}
              >
                {why}
              </p>
            )}
            {summary}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
              {meta}
            </div>
          </>
        }
      >
        {children}
      </DecisionRow>
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
    <div data-inbox-actions className="flex-wrap">
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
  workflowRuns,
  workflowSteps,
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
  onContinueCoordinator,
  onSession,
  onDiff,
  onReply,
  onRefresh,
  automations,
  automationPending,
  automationErrors,
  onAutomation,
  onAutomationDecision,
  originLabel,
  notice,
  lessons,
  gateRules,
  stages,
  ruleItems,
  linkedItem,
  rulePending,
  ruleErrors,
  onRuleDecision,
  onRuleOpenChanges,
  onRuleOpenPullRequest,
  routeOf,
  ...decisionProps
}: Props) {
  useEffect(() => {
    if (!linkedItem) return;
    const row = document.getElementById(
      `inbox-${linkedItem.hostId}-${linkedItem.id}`,
    );
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [linkedItem, ruleItems]);
  const [filter, setFilter] = useState<Filter>('pending');
  const heldSessions = new Set(
    ruleItems
      .filter(item => item.status === 'pending' && item.binding === 'provider')
      .map(item => `${item.hostId}/${item.sessionId}`),
  );
  const inInbox = (session: Session) => routesToInbox(routeOf(session));
  const [gateFeedback, setGateFeedback] = useState<{
    row: GateRuleProposal;
    hostId: string;
    undone?: boolean;
  } | null>(null);
  const [undoError, setUndoError] = useState('');
  const [undoPending, setUndoPending] = useState(false);
  const undoSaved = async () => {
    if (!gateFeedback?.row.changeId) return;
    setUndoPending(true);
    setUndoError('');
    try {
      await undoGateRule(gateFeedback.hostId, {
        conversationId: gateFeedback.row.sessionId,
        changeId: gateFeedback.row.changeId,
      });
      setGateFeedback({ ...gateFeedback, undone: true });
    } catch (reason) {
      setUndoError(errorDetail(reason));
    } finally {
      setUndoPending(false);
    }
  };
  const rows: ActionRow[] = reviews
    .filter(
      review =>
        review.status !== 'done' &&
        routesToInbox(review.route ?? 'inbox') &&
        (filter === 'all' ||
          (filter === 'pending'
            ? review.status === 'pending'
            : review.status !== 'pending')),
    )
    .map(review => ({
      type: 'review',
      review,
      at: review.createdAt,
      id: entityKey(review),
    }));
  if (filter !== 'history')
    for (const run of workflowRuns) {
      if (run.status !== 'awaiting-human') continue;
      for (const step of workflowSteps) {
        if (
          step.runId !== run.id ||
          step.hostId !== run.hostId ||
          step.state !== 'awaiting-human'
        )
          continue;
        rows.push({
          type: 'workflow-gate',
          run,
          step,
          at: step.startedAt ?? run.updatedAt,
          id: hostKey(step.id, run.hostId),
        });
      }
    }
  if (filter !== 'history')
    for (const session of sessions)
      if (session.coordinatorWait)
        rows.push({
          type: 'coordinator-wait',
          session,
          at: session.coordinatorWait.startedAt,
          id: entityKey(session),
        });
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
      for (const request of session.steeringRequests ?? [])
        if (
          session.status === 'running' &&
          session.runId === request.runId &&
          routesToInbox(request.route)
        )
          rows.push({
            type: 'steering',
            session,
            request,
            at: request.createdAt,
            id: `${key}/${request.id}`,
          });
      if (inInbox(session) && session.plan?.status === 'plan-ready')
        rows.push({
          type: 'plan',
          session,
          plan: session.plan,
          at: session.plan.readyAt ?? session.updatedAt,
          id: `${key}/${session.plan.id}`,
        });
      const question = pendingStageQuestion(session);
      if (
        question &&
        routesToInbox(session.questionRouteOverride ?? routeOf(session))
      )
        rows.push({
          type: 'question',
          session,
          record: question,
          at: question.at,
          id: `${key}/${question.id}`,
        });
      const turnQuestion = pendingTurnQuestion(session);
      if (turnQuestion && routesToInbox(turnQuestion.route))
        rows.push({
          type: 'turn-question',
          session,
          question: turnQuestion,
          at: session.updatedAt,
          id: `${key}/${turnQuestion.runId}`,
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
  const decisionCount = rows.filter(
    row => row.type !== 'gate-rule-proposal' || row.row.status === 'pending',
  ).length;
  if (
    filter !== 'history' &&
    gateFeedback &&
    !rows.some(
      row =>
        row.type === 'gate-rule-proposal' &&
        row.id === hostKey(gateFeedback.row.id, gateFeedback.hostId),
    )
  ) {
    rows.push({
      type: 'gate-rule-proposal',
      row: gateFeedback.row,
      hostId: gateFeedback.hostId,
      id: hostKey(gateFeedback.row.id, gateFeedback.hostId),
      at: gateFeedback.row.createdAt,
    });
  }
  rows.sort(
    (left, right) =>
      right.at.localeCompare(left.at) || left.id.localeCompare(right.id),
  );
  const [assistant, setAssistant] = useState<AssistantSelection | null>(null);
  const changes = useConfigurationChanges(computers);
  const shownChanges = changes.filter(change => {
    const needsReview =
      change.status === 'pending' || change.status === 'conflicted';
    return (
      filter === 'all' || (filter === 'pending' ? needsReview : !needsReview)
    );
  });
  const activeComputer = computers.find(
    computer => computer.id === assistant?.hostId,
  );
  const defaultComputer = computers.find(
    computer =>
      computer.status === 'connected' &&
      computer.capabilities.includes('configuration'),
  );
  const location = (hostId: string) => {
    const online = isOperationEnabled({ hostId });
    if (hostId === 'local' && computers.length <= 1 && online) return '';
    const name = computers.find(item => item.id === hostId)?.name ?? hostId;
    return online ? name : `${name} · Offline snapshot`;
  };
  const inbox = (
    <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:h-full [&_[data-slot=scroll-area-viewport]]:scroll-pt-12">
      <section
        aria-label="Inbox"
        className="group/inbox mx-auto flex min-h-full w-full max-w-5xl flex-col px-5 pb-6 xl:ml-5 [&_article]:scroll-mt-2"
      >
        <div className="sticky top-0 z-10 mb-1 flex items-center justify-between gap-3 border-b bg-background px-2 py-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {decisionCount + shownChanges.length > 0 &&
              `${decisionCount + shownChanges.length} ${filter === 'history' ? 'past decisions' : filter === 'all' ? 'items' : 'pending'}`}
          </span>
          {defaultComputer && (
            <IconButton
              className="ml-auto"
              label="Open Inbox assistant"
              onClick={() =>
                setAssistant({ hostId: defaultComputer.id, subject: null })
              }
            >
              <MessageSquareText />
            </IconButton>
          )}
          <SegmentedControl<Filter>
            label="Inbox view"
            value={filter}
            options={[
              { value: 'pending', label: 'Pending' },
              { value: 'history', label: 'History' },
              { value: 'all', label: 'All' },
            ]}
            onChange={setFilter}
          />
        </div>
        {notice}
        {filter !== 'history' && lessons}
        {filter !== 'history' &&
          gateRules.errors.map(message => (
            <StatusMessage key={message} className="mb-2 px-2" tone="error">
              {message}
            </StatusMessage>
          ))}
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
              row.type === 'turn-question' ||
              row.type === 'steering' ||
              row.type === 'automation',
          ) && (
            <StatusMessage className="mb-3 px-2">
              Reconnect to respond to pending requests.
            </StatusMessage>
          )}
        {shownChanges.map(change => (
          <ConfigurationChangeRow
            key={`${change.hostId}/${change.id}`}
            change={change}
            computer={location(change.hostId) || 'Local'}
            online={isOperationEnabled(change)}
            onOpenSession={id => onSession(hostKey(id, change.hostId))}
          />
        ))}
        {rows.length > 0 ? (
          <div className="divide-y divide-border/55">
            {rows.map(row => {
              const wrap = (content: ReactNode) => {
                const selection = assistantSubject(row);
                const supports = computers.some(
                  computer =>
                    computer.id === selection?.hostId &&
                    computer.capabilities.includes('configuration'),
                );
                return (
                  <div
                    key={row.id}
                    data-inbox-row=""
                    className="flex min-w-0 items-center"
                  >
                    <div className="min-w-0 flex-1">{content}</div>
                    {selection && supports && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton label="Inbox item actions">
                            <Ellipsis />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => setAssistant(selection)}
                          >
                            Change how this reaches me
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                );
              };
              if (row.type === 'gate-rule-proposal') {
                const title =
                  sessions.find(
                    session =>
                      session.hostId === row.hostId &&
                      session.id === row.row.taskSessionId,
                  )?.title ?? row.row.workflow;
                if (
                  gateFeedback?.hostId === row.hostId &&
                  gateFeedback.row.id === row.row.id
                )
                  return (
                    <ActionItem
                      key={row.id}
                      aria-label="Gate rule decision"
                      title={title}
                      location={location(row.hostId)}
                      typeLabel="Gate rule proposal"
                      summary={
                        <p className="text-ui">{row.row.proposal.body.rule}</p>
                      }
                      meta={
                        <StatusMessage tone={undoError ? 'error' : 'success'}>
                          {undoError ||
                            (gateFeedback.undone
                              ? 'Gate rule change undone'
                              : gateFeedback.row.status === 'dismissed'
                                ? 'Gate rule dismissed'
                                : 'Gate rule saved')}
                        </StatusMessage>
                      }
                    >
                      <div data-inbox-actions>
                        {gateFeedback.row.changeId && !gateFeedback.undone && (
                          <Button
                            variant="ghost"
                            disabled={undoPending}
                            onClick={() => void undoSaved()}
                          >
                            Undo
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          onClick={() => setGateFeedback(null)}
                        >
                          Close
                        </Button>
                      </div>
                    </ActionItem>
                  );
                return wrap(
                  <GateRuleRow
                    key={row.id}
                    row={row.row}
                    hostId={row.hostId}
                    title={title}
                    location={location(row.hostId)}
                    onSession={onSession}
                    onSaved={(saved, hostId) => {
                      setUndoError('');
                      setGateFeedback({ row: saved, hostId });
                    }}
                  />,
                );
              }
              if (row.type === 'coordinator-wait') {
                const { session } = row;
                return wrap(
                  <ListRow
                    key={row.id}
                    title={session.title}
                    onClick={() => onSession(entityKey(session))}
                    actions={
                      <CoordinatorWait
                        session={session}
                        sessions={sessions}
                        enabled={isOperationEnabled(session)}
                        onContinue={() => onContinueCoordinator(session)}
                      />
                    }
                    actionsPlacement="visible"
                  />,
                );
              }
              if (row.type === 'steering') {
                const { session, request } = row;
                return (
                  <ActionItem
                    key={row.id}
                    title={session.title}
                    location={location(session.hostId)}
                    aria-label={`Approve feedback: ${session.title}`}
                    data-inbox-kind="decision-needed"
                    onOpen={() => onSession(entityKey(session))}
                    why="Send feedback to the worker's active run"
                    summary={
                      <NativeDisclosure title="Feedback text">
                        <p className="whitespace-pre-wrap break-words text-ui">
                          {request.text}
                        </p>
                      </NativeDisclosure>
                    }
                    meta={reviewDate(request.createdAt)}
                  >
                    <SteeringDecisionActions
                      child={session}
                      request={request}
                      enabled={operationEnabled && isOperationEnabled(session)}
                    />
                  </ActionItem>
                );
              }
              if (row.type === 'turn-question') {
                const { session, question } = row;
                return wrap(
                  <ActionItem
                    key={row.id}
                    aria-label={`Question for you: ${session.title}`}
                    data-inbox-kind="question-for-you"
                    title={session.title}
                    onOpen={() =>
                      onSession(entityKey(session), question.messageId)
                    }
                    why={
                      question.questions.some(item => item.options.length)
                        ? 'Asks you to choose an option'
                        : 'Asks for your reply'
                    }
                    location={location(session.hostId)}
                    summary={null}
                    meta={null}
                  >
                    <TurnQuestionReply
                      questions={question.questions}
                      enabled={
                        operationEnabled &&
                        isOperationEnabled(session) &&
                        !ruleItems.some(
                          item =>
                            item.status === 'pending' &&
                            item.action === 'hold' &&
                            item.sessionId === session.id &&
                            item.hostId === session.hostId,
                        )
                      }
                      onReply={(text, messageId) =>
                        onReply(session, question.runId, text, messageId)
                      }
                    />
                  </ActionItem>,
                );
              }
              if (row.type === 'workflow-gate') {
                const { run, step } = row;
                const task = sessions.find(
                  session =>
                    session.hostId === run.hostId &&
                    session.id === run.sessionId,
                );
                const definition = run.workflow.steps.find(
                  item => item.name === step.name,
                );
                return wrap(
                  <ActionItem
                    key={row.id}
                    aria-label={`Workflow gate: ${step.name}`}
                    data-host-id={run.hostId}
                    data-workflow-step-id={step.id}
                    typeLabel={`Workflow decision · ${step.name}`}
                    title={task?.title ?? run.specTitle ?? run.workflow.name}
                    onOpen={
                      run.sessionId
                        ? () => onSession(hostKey(run.sessionId!, run.hostId))
                        : undefined
                    }
                    location={location(run.hostId)}
                    summary={
                      <p className="line-clamp-3 text-ui whitespace-pre-wrap">
                        {definition?.body.trim() ||
                          'Review this step before the workflow continues.'}
                      </p>
                    }
                    meta={<time dateTime={row.at}>{reviewDate(row.at)}</time>}
                  >
                    <WorkflowGateDecision
                      run={run}
                      step={step}
                      enabled={isOperationEnabled(run)}
                    />
                  </ActionItem>,
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
                const awaitingGate = rows.some(
                  item =>
                    item.type === 'workflow-gate' &&
                    item.run.hostId === review.hostId &&
                    item.run.sessionId === review.sessionId,
                );
                const reviewError =
                  decisionProps.decisionErrors[entityKey(review)];
                return wrap(
                  <ActionItem
                    key={`review/${row.id}`}
                    aria-label={`Review result: ${review.title}, version ${review.version}`}
                    data-host-id={review.hostId}
                    title={
                      origin.startsWith('Automation · ')
                        ? origin.slice('Automation · '.length)
                        : title
                    }
                    typeLabel={
                      review.status === 'pending'
                        ? 'Saved result'
                        : reviewStatusLabels[review.status]
                    }
                    why={resultReason(review)}
                    data-inbox-kind="result-to-review"
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
                        {review.diff.files.length > 0 && (
                          <Button
                            variant="link"
                            size="inline"
                            onClick={() => onDiff(review)}
                          >
                            Open diff
                          </Button>
                        )}
                        <span>Version {review.version}</span>
                        {review.diff.status === 'unavailable' && (
                          <span>· Diff unavailable</span>
                        )}
                        <time dateTime={review.createdAt}>
                          {reviewDate(review.createdAt)}
                        </time>
                      </>
                    }
                  >
                    {awaitingGate ? (
                      <StatusMessage className="col-span-full">
                        Decide the workflow step before reviewing this result.
                      </StatusMessage>
                    ) : review.status === 'pending' ? (
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
                  </ActionItem>,
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
                return wrap(
                  <ActionItem
                    key={`rule/${row.id}`}
                    aria-label={
                      item.binding === 'external'
                        ? `External Inbox item: ${item.subject}`
                        : `Inbox rule ${item.rule.name}: ${item.sessionTitle}`
                    }
                    id={`inbox-${item.hostId}-${item.id}`}
                    tabIndex={-1}
                    data-host-id={item.hostId}
                    typeLabel={
                      item.status !== 'pending'
                        ? inboxRuleMeta(item)
                        : item.binding === 'external'
                          ? 'External request'
                          : item.trigger === 'workflow-step'
                            ? 'Workflow step hold'
                            : item.action === 'hold'
                              ? 'Operation held by a rule'
                              : 'Inbox rule'
                    }
                    data-inbox-rule={item.rule?.name}
                    data-inbox-type={
                      item.binding === 'external' ? 'external' : undefined
                    }
                    title={subjectSession?.title ?? item.sessionTitle}
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
                    data-inbox-kind="decision-needed"
                    why={
                      item.binding === 'external'
                        ? item.subject
                        : item.action === 'hold'
                          ? `Waiting for approval: ${item.subject}`
                          : item.subject
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
                        {item.status === 'pending' && (
                          <span>{inboxRuleMeta(item)}</span>
                        )}
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
                      compact
                      item={item}
                      enabled={isOperationEnabled(item)}
                      deciding={!!rulePending[key]}
                      error={ruleErrors[key]}
                      onDecide={decision => onRuleDecision(item, decision)}
                    />
                  </ActionItem>,
                );
              }
              if (row.type === 'automation') {
                const { job, at } = row;
                const key = entityKey(job);
                const deciding = !!automationPending[key];
                return wrap(
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
                  </ActionItem>,
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
                return wrap(
                  <ActionItem
                    key={`plan/${row.id}`}
                    data-inbox-kind="decision-needed"
                    why="Plan needs your approval"
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
                  </ActionItem>,
                );
              }
              if (row.type === 'question') {
                const { record } = row;
                return wrap(
                  <ActionItem
                    key={`question/${row.id}`}
                    why={
                      record.question.options.length
                        ? 'Asks you to choose an option'
                        : 'Asks for your reply'
                    }
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
                  </ActionItem>,
                );
              }
              if (row.type === 'parent') {
                const { request } = row;
                const deciding = !!parentPending[row.id];
                return wrap(
                  <ActionItem
                    key={`parent/${row.id}`}
                    why="Asks to join a coordinator"
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
                  </ActionItem>,
                );
              }
              if (row.type === 'approval') {
                const { approval } = row;
                const deciding = !!approvalPending[row.id];
                const enabled =
                  operationEnabled && isOperationEnabled(session) && !deciding;
                return wrap(
                  <ActionItem
                    key={`approval/${row.id}`}
                    data-inbox-kind="decision-needed"
                    why={
                      approval.kind === 'command'
                        ? `Wants to run ${compactPreview(approval.detail, 100).split(/\s+/, 2).join(' ')}`
                        : `Requests approval: ${approval.title}`
                    }
                    aria-label={`Operation approval: ${session.title}`}
                    typeLabel="Operation approval"
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
                      compact
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
                  </ActionItem>,
                );
              }
              const { delegation } = row;
              const deciding = !!delegationPending[row.id];
              const enabled =
                operationEnabled && isOperationEnabled(session) && !deciding;
              return wrap(
                <ActionItem
                  key={`delegation/${row.id}`}
                  why={`Wants to start a worker: ${delegation.title}`}
                  aria-label={`Start worker: ${delegation.title}`}
                  data-host-id={session.hostId}
                  typeLabel="Worker approval"
                  title={delegation.title}
                  openLabel={`Open session: ${session.title}`}
                  onOpen={() =>
                    onSession(entityKey(session), `delegation-${delegation.id}`)
                  }
                  location={location(session.hostId)}
                  summary={
                    <NativeDisclosure title={delegation.scope || 'Worker task'}>
                      <p className="text-ui whitespace-pre-wrap [overflow-wrap:anywhere]">
                        {delegation.task}
                      </p>
                    </NativeDisclosure>
                  }
                  meta={
                    <>
                      <span>
                        Worker · {delegation.provider} ·{' '}
                        {modelLabel(delegation.model)} ·{' '}
                        {modeLabel(delegation.provider, delegation.mode)}
                      </span>
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
                </ActionItem>,
              );
            })}
          </div>
        ) : (
          !shownChanges.length &&
          !loading &&
          !error && (
            <EmptyState
              icon={Inbox}
              className="flex-1 group-has-[[data-lesson-key]]/inbox:hidden"
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
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {inbox}
      {assistant && activeComputer && (
        <InboxAssistant
          key={
            assistant.hostId +
            '/' +
            (assistant.subject?.kind ?? '') +
            '/' +
            (assistant.subject?.id ?? '')
          }
          computer={activeComputer}
          subject={assistant.subject}
          changes={changes}
          close={() => setAssistant(null)}
          openSession={id => onSession(hostKey(id, assistant.hostId))}
        />
      )}
    </div>
  );
}
