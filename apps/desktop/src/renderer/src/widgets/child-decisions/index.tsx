import {
  pendingStageQuestion,
  pendingTurnQuestion,
  routesToParent,
  type DecisionRoute,
  type PullRequestReference,
  type RespondApprovalInput,
} from '@nesvo/contracts';
import { ArrowUpRight } from 'lucide-react';
import { approvalKindLabels, type Session } from '@/entities/session';
import {
  InboxRuleDecisions,
  InboxRuleSummary,
  inboxItemKey,
  inboxRuleMeta,
  type HostedInboxItem,
  type InboxItemDecision,
} from '@/features/inbox-rules';
import { resultReason, reviewPreview, type Review } from '@/entities/review';
import {
  ReviewDecision,
  type ReviewDecisionProps,
} from '@/features/review-decision';
import { TurnQuestionReply } from '@/features/review-decision/turn-question-reply';
import { entityKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { SteeringDecisionActions } from '@/features/session-mode/steering-decision-actions';
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusMessage } from '@/shared/ui/status-message';
import {
  PlanDecision,
  QuestionAnswer,
  type StageActions,
} from '@/widgets/session-stages';

type Props = {
  parent: Session;
  sessions: Session[];
  items: HostedInboxItem[];
  routeOf: (session: Session) => DecisionRoute;
  reviews: Review[];
  reviewDecisions: ReviewDecisionProps;
  onOpenDiff: (review: Review) => void;
  onReply: (
    session: Session,
    runId: string,
    text: string,
    messageId: string,
  ) => Promise<void>;
  enabled: boolean;
  stages: StageActions;
  rulePending: Record<string, boolean>;
  ruleErrors: Record<string, string>;
  onRuleDecision: (item: HostedInboxItem, decision: InboxItemDecision) => void;
  approvalPending: Record<string, boolean>;
  onApproval: (input: RespondApprovalInput, hostId: string) => void;
  onOpen: (sessionKey: string) => void;
  onOpenChanges: (item: HostedInboxItem) => void;
  onOpenPullRequest: (
    item: HostedInboxItem,
    reference: PullRequestReference,
  ) => void;
};

const COLUMNS = 'minmax(0,1fr) auto';

function CardHeader({
  title,
  what,
  onOpen,
}: {
  title: string;
  what: string;
  onOpen: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      <Button
        variant="link"
        size="inline"
        className="max-w-full justify-start text-ui text-foreground"
        aria-label={`Open session: ${title}`}
        onClick={onOpen}
      >
        <span className="truncate">{title}</span>
        <ArrowUpRight className="size-3 text-muted-foreground" />
      </Button>
      <span className="text-2xs text-muted-foreground">{what}</span>
    </div>
  );
}

export function ChildDecisions({
  parent,
  sessions,
  items,
  routeOf,
  reviews,
  reviewDecisions,
  onOpenDiff,
  onReply,
  enabled,
  stages,
  rulePending,
  ruleErrors,
  onRuleDecision,
  approvalPending,
  onApproval,
  onOpen,
  onOpenChanges,
  onOpenPullRequest,
}: Props) {
  const ruleItems = items.filter(
    item =>
      item.status === 'pending' &&
      item.parentId === parent.id &&
      item.hostId === parent.hostId &&
      routesToParent(item.route),
  );
  const heldChildren = new Set(
    ruleItems
      .filter(item => item.binding === 'provider')
      .map(item => item.sessionId),
  );
  const allChildren = sessions.filter(
    session =>
      session.parentId === parent.id && session.hostId === parent.hostId,
  );
  const children = allChildren.filter(session =>
    routesToParent(routeOf(session)),
  );
  const steering = allChildren.flatMap(child =>
    (child.steeringRequests ?? [])
      .filter(
        request =>
          child.status === 'running' &&
          child.runId === request.runId &&
          routesToParent(request.route),
      )
      .map(request => ({ child, request })),
  );
  const turnQuestions = allChildren.flatMap(child => {
    const question = pendingTurnQuestion(child);
    return question && routesToParent(question.route)
      ? [{ child, question }]
      : [];
  });
  const results = reviews.flatMap(review => {
    const child = allChildren.find(
      item => item.id === review.sessionId && item.hostId === review.hostId,
    );
    return child &&
      review.status === 'pending' &&
      review.route &&
      routesToParent(review.route)
      ? [{ child, review }]
      : [];
  });
  const approvals = children.flatMap(child =>
    child.status === 'running' && child.runId && !heldChildren.has(child.id)
      ? child.pendingApprovals.map(approval => ({ child, approval }))
      : [],
  );
  const plans = children.filter(child => child.plan?.status === 'plan-ready');
  const questions = allChildren
    .filter(child =>
      routesToParent(child.questionRouteOverride ?? routeOf(child)),
    )
    .flatMap(child => {
      const question = pendingStageQuestion(child);
      return question ? [{ child, question }] : [];
    });
  const count =
    ruleItems.length +
    approvals.length +
    plans.length +
    questions.length +
    turnQuestions.length +
    steering.length +
    results.length;
  if (!count) return null;
  return (
    <section
      aria-label="Decisions from child sessions"
      className="space-y-1.5 rounded-surface border bg-card p-2"
    >
      <SectionLabel as="h2" className="px-2">
        {count === 1
          ? 'A child session waits for you'
          : `${count} child decisions wait for you`}
      </SectionLabel>
      <div className="space-y-px">
        {steering.map(({ child, request }) => (
          <article
            key={request.id}
            aria-label={`Approve feedback: ${child.title}`}
          >
            <ListRow density="block" columns={COLUMNS}>
              <div className="min-w-0 space-y-1">
                <CardHeader
                  title={child.title}
                  what="Approve feedback"
                  onOpen={() => onOpen(entityKey(child))}
                />
                <NativeDisclosure title="Feedback text">
                  <p className="whitespace-pre-wrap break-words text-ui">
                    {request.text}
                  </p>
                </NativeDisclosure>
              </div>
              <SteeringDecisionActions
                child={child}
                request={request}
                enabled={enabled}
              />
            </ListRow>
          </article>
        ))}
        {turnQuestions.map(({ child, question }) => (
          <article
            key={question.messageId}
            aria-label={`Question for you: ${child.title}`}
          >
            <ListRow density="block" columns={COLUMNS}>
              <CardHeader
                title={child.title}
                what="Question for you"
                onOpen={() => onOpen(entityKey(child))}
              />
              <TurnQuestionReply
                questions={question.questions}
                enabled={enabled}
                onReply={(text, id) => onReply(child, question.runId, text, id)}
              />
            </ListRow>
          </article>
        ))}
        {results.map(({ child, review }) => (
          <article
            key={review.id}
            aria-label={`Result to review: ${child.title}`}
          >
            <ListRow density="block" columns={COLUMNS}>
              <div className="min-w-0 space-y-1">
                <CardHeader
                  title={child.title}
                  what={resultReason(review)}
                  onOpen={() => onOpen(entityKey(child))}
                />
                <p className="line-clamp-2 text-ui">{reviewPreview(review)}</p>
                {review.diff.files.length > 0 && (
                  <Button
                    size="inline"
                    variant="link"
                    onClick={() => onOpenDiff(review)}
                  >
                    Open diff
                  </Button>
                )}
              </div>
              <ReviewDecision compact review={review} {...reviewDecisions} />
            </ListRow>
          </article>
        ))}
        {ruleItems.map(item => {
          const key = inboxItemKey(item);
          return (
            <article
              key={key}
              aria-label={`Child decision: ${item.sessionTitle}`}
              data-inbox-rule={item.rule?.name}
            >
              <ListRow density="block" columns={COLUMNS}>
                <div className="min-w-0 space-y-1">
                  <CardHeader
                    title={
                      item.binding === 'external'
                        ? item.subject
                        : item.sessionTitle
                    }
                    what={
                      item.binding === 'external'
                        ? `${item.sessionTitle} · ${inboxRuleMeta(item)}`
                        : inboxRuleMeta(item)
                    }
                    onOpen={() =>
                      item.sessionId &&
                      onOpen(
                        entityKey({ id: item.sessionId, hostId: item.hostId }),
                      )
                    }
                  />
                  <InboxRuleSummary
                    item={item}
                    onOpenChanges={() => onOpenChanges(item)}
                    onOpenPullRequest={reference =>
                      onOpenPullRequest(item, reference)
                    }
                  />
                </div>
                <InboxRuleDecisions
                  item={item}
                  via="parent"
                  enabled={enabled}
                  deciding={!!rulePending[key]}
                  error={ruleErrors[key]}
                  onDecide={decision => onRuleDecision(item, decision)}
                />
              </ListRow>
            </article>
          );
        })}
        {approvals.map(({ child, approval }) => {
          const key = `${entityKey(child)}/${child.runId}/${approval.id}`;
          return (
            <article key={key} aria-label={`Child approval: ${child.title}`}>
              <ListRow density="block" columns={COLUMNS}>
                <div className="min-w-0 space-y-1">
                  <CardHeader
                    title={child.title}
                    what={`${approvalKindLabels[approval.kind]} · ${approval.title}`}
                    onOpen={() => onOpen(entityKey(child))}
                  />
                  <CodeBlock
                    code={approval.detail.slice(0, 4000)}
                    wrap
                    maxHeightClassName="max-h-32"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 self-center">
                  {(['accept', 'decline'] as const).map(decision => (
                    <Button
                      key={decision}
                      variant={decision === 'accept' ? 'secondary' : 'ghost'}
                      disabled={!enabled || !!approvalPending[key]}
                      onClick={() =>
                        onApproval(
                          {
                            sessionId: child.id,
                            runId: child.runId!,
                            requestId: approval.id,
                            decision,
                            ...(approval.fingerprint
                              ? { fingerprint: approval.fingerprint }
                              : {}),
                          },
                          child.hostId,
                        )
                      }
                    >
                      {decision === 'accept' ? 'Allow once' : 'Deny'}
                    </Button>
                  ))}
                </div>
              </ListRow>
            </article>
          );
        })}
        {plans.map(child => (
          <article
            key={`${entityKey(child)}/plan`}
            aria-label={`Child plan: ${child.title}`}
          >
            <ListRow density="block" columns={COLUMNS}>
              <div className="min-w-0 space-y-1">
                <CardHeader
                  title={child.title}
                  what="Plan ready"
                  onOpen={() => onOpen(entityKey(child))}
                />
                <p className="line-clamp-3 text-ui whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {child.plan?.text}
                </p>
              </div>
              <PlanDecision session={child} actions={stages} compact />
            </ListRow>
          </article>
        ))}
        {questions.map(({ child, question }) => (
          <article
            key={`${entityKey(child)}/${question.id}`}
            aria-label={`Child question: ${child.title}`}
          >
            <ListRow density="block" columns={COLUMNS}>
              <div className="min-w-0 space-y-1">
                <CardHeader
                  title={child.title}
                  what="Question"
                  onOpen={() => onOpen(entityKey(child))}
                />
                <p className="text-ui [overflow-wrap:anywhere]">
                  {question.question.question}
                </p>
              </div>
              <QuestionAnswer
                session={child}
                record={question}
                actions={stages}
                compact
              />
            </ListRow>
          </article>
        ))}
      </div>
      {!enabled && (
        <StatusMessage className="px-2">
          Reconnect to decide for child sessions.
        </StatusMessage>
      )}
    </section>
  );
}
