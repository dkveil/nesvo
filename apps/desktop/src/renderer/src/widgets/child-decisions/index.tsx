import {
  pendingStageQuestion,
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
import { entityKey } from '@/shared/lib/host-key';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
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
  const children = sessions.filter(
    session =>
      session.parentId === parent.id &&
      session.hostId === parent.hostId &&
      routesToParent(routeOf(session)),
  );
  const approvals = children.flatMap(child =>
    child.status === 'running' && child.runId && !heldChildren.has(child.id)
      ? child.pendingApprovals.map(approval => ({ child, approval }))
      : [],
  );
  const plans = children.filter(child => child.plan?.status === 'plan-ready');
  const questions = children.flatMap(child => {
    const question = pendingStageQuestion(child);
    return question ? [{ child, question }] : [];
  });
  const count =
    ruleItems.length + approvals.length + plans.length + questions.length;
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
