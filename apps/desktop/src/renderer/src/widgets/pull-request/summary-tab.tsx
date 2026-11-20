import type { ReactNode } from 'react';
import type { PullRequest, PullRequestCheck } from '@nesvo/contracts';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { StatusIcon, type StatusKind } from '@/entities/status';
import { MessageBody } from '@/widgets/conversation/message-body';
import { Badge } from '@/shared/ui/badge';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { SectionLabel } from '@/shared/ui/section-label';
import { openExternal } from './open-external';
import type { ReviewDraft, ReviewEvent } from './review-event';
import { ReviewForm } from './review-form';
import type { ActionState } from './use-pull-request-actions';

const REVIEW_DECISION_LABELS: Record<PullRequest['reviewDecision'], string> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  none: '',
};

type SummaryTabProps = {
  pullRequest: PullRequest;
  blockedReason: string;
  reviewEvents: ReviewEvent[];
  reviewDraft: ReviewDraft;
  reviewState: ActionState | undefined;
  onReviewDraftChange: (draft: ReviewDraft) => void;
  onReview: () => void;
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <SectionLabel className="px-0">{title}</SectionLabel>
      {children}
    </section>
  );
}

const checkStatus = (check: PullRequestCheck): StatusKind => {
  if (check.status !== 'completed') return 'pending';
  if (check.conclusion === 'success') return 'success';
  if (
    check.conclusion === 'failure' ||
    check.conclusion === 'timed-out' ||
    check.conclusion === 'action-required' ||
    check.conclusion === 'cancelled'
  )
    return 'error';
  return 'idle';
};

const checkLabel = (check: PullRequestCheck) =>
  check.status === 'completed'
    ? (check.conclusion ?? 'completed').replace('-', ' ')
    : check.status.replace('-', ' ');

export function SummaryTab({
  pullRequest,
  blockedReason,
  reviewEvents,
  reviewDraft,
  reviewState,
  onReviewDraftChange,
  onReview,
}: SummaryTabProps) {
  const decision = REVIEW_DECISION_LABELS[pullRequest.reviewDecision];
  return (
    <div className="@container space-y-5 px-4 py-4">
      <div className="grid gap-4 @min-[24rem]:grid-cols-2">
        <Section title="Reviewers">
          {decision && (
            <span
              className={cn(
                'block text-xs',
                pullRequest.reviewDecision === 'approved' &&
                  'text-success-foreground',
                pullRequest.reviewDecision === 'changes-requested' &&
                  'text-error-foreground',
              )}
            >
              {decision}
            </span>
          )}
          {pullRequest.reviewers.length > 0 ? (
            <ul className="flex flex-wrap gap-1">
              {pullRequest.reviewers.map(reviewer => (
                <li key={reviewer.login}>
                  <Badge>{reviewer.login}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-2xs text-muted-foreground">No reviewers</p>
          )}
        </Section>
        <Section title="Labels">
          {pullRequest.labels.length > 0 ? (
            <ul className="flex flex-wrap gap-1">
              {pullRequest.labels.map(label => (
                <li key={label}>
                  <Badge appearance="outline">{label}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-2xs text-muted-foreground">No labels</p>
          )}
        </Section>
      </div>
      {pullRequest.checkRuns.length > 0 && (
        <Section title={`Checks · ${pullRequest.checkRuns.length}`}>
          <ul className="-mx-2 space-y-px">
            {pullRequest.checkRuns.map((check, index) => (
              <li key={`${check.name}:${index}`}>
                <ListRow
                  leading={
                    <StatusIcon
                      status={checkStatus(check)}
                      className="size-3.5"
                    />
                  }
                  title={check.name}
                  trailing={
                    <span className="capitalize">{checkLabel(check)}</span>
                  }
                  actions={
                    check.url && (
                      <IconButton
                        label={`Open check ${check.name}`}
                        size={20}
                        onClick={() => check.url && openExternal(check.url)}
                      >
                        <ExternalLink />
                      </IconButton>
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Description">
        {pullRequest.body.trim() ? (
          <MessageBody
            body={pullRequest.body}
            githubPullRequestUrl={pullRequest.url}
            className="text-ui leading-6 [&_details]:space-y-2 [&_summary]:cursor-pointer [&_summary]:font-medium"
          />
        ) : (
          <p className="text-xs text-muted-foreground">No description.</p>
        )}
      </Section>
      {pullRequest.state === 'open' && (
        <Section title="Your review">
          <ReviewForm
            events={reviewEvents}
            draft={reviewDraft}
            blockedReason={blockedReason}
            state={reviewState}
            onChange={onReviewDraftChange}
            onSubmit={onReview}
          />
        </Section>
      )}
    </div>
  );
}
