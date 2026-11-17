import { useState, type ReactNode } from 'react';
import type { PullRequest, PullRequestCheck } from '@nesvo/contracts';
import {
  CircleCheck,
  CircleDot,
  CircleMinus,
  CircleX,
  ExternalLink,
} from 'lucide-react';
import { cn } from 'cn';
import { MessageBody } from '@/widgets/conversation/message-body';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { CommentBox } from './comment-box';
import { openExternal } from './open-external';
import type { ActionState } from './use-pull-request-actions';

type ReviewEvent = 'approve' | 'request-changes' | 'comment';

const REVIEW_DECISION_LABELS: Record<PullRequest['reviewDecision'], string> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  none: '',
};

const REVIEW_EVENT_LABELS: Record<ReviewEvent, string> = {
  approve: 'Approve',
  'request-changes': 'Request changes',
  comment: 'Comment',
};

type SummaryTabProps = {
  pullRequest: PullRequest;
  blockedReason: string;
  reviewState: ActionState | undefined;
  onReview: (event: ReviewEvent, body: string) => Promise<boolean>;
  onReviewEdit: () => void;
};

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center justify-between gap-2 text-2xs font-medium text-muted-foreground">
        {title}
        {aside}
      </h3>
      {children}
    </section>
  );
}

function CheckGlyph({ check }: { check: PullRequestCheck }) {
  if (check.status !== 'completed')
    return (
      <CircleDot
        aria-hidden="true"
        className="size-3.5 shrink-0 text-warning-foreground"
      />
    );
  if (check.conclusion === 'success')
    return (
      <CircleCheck
        aria-hidden="true"
        className="size-3.5 shrink-0 text-success-foreground"
      />
    );
  if (
    check.conclusion === 'failure' ||
    check.conclusion === 'timed-out' ||
    check.conclusion === 'action-required' ||
    check.conclusion === 'cancelled'
  )
    return (
      <CircleX
        aria-hidden="true"
        className="size-3.5 shrink-0 text-error-foreground"
      />
    );
  return (
    <CircleMinus
      aria-hidden="true"
      className="size-3.5 shrink-0 text-muted-foreground"
    />
  );
}

const checkLabel = (check: PullRequestCheck) =>
  check.status === 'completed'
    ? (check.conclusion ?? 'completed').replace('-', ' ')
    : check.status.replace('-', ' ');

export function SummaryTab({
  pullRequest,
  blockedReason,
  reviewState,
  onReview,
  onReviewEdit,
}: SummaryTabProps) {
  const events: ReviewEvent[] = pullRequest.viewerCanReview
    ? ['approve', 'request-changes', 'comment']
    : ['comment'];
  const [chosen, setChosen] = useState<ReviewEvent>('comment');
  const event = events.includes(chosen) ? chosen : 'comment';
  const [body, setBody] = useState('');
  const decision = REVIEW_DECISION_LABELS[pullRequest.reviewDecision];
  const canSubmit = event === 'approve' || !!body.trim();
  const submit = async () => {
    if (await onReview(event, body.trim())) setBody('');
  };
  return (
    <div className="space-y-5 px-4 py-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Section
          title="Reviewers"
          aside={
            decision && (
              <span
                className={cn(
                  pullRequest.reviewDecision === 'approved' &&
                    'text-success-foreground',
                  pullRequest.reviewDecision === 'changes-requested' &&
                    'text-error-foreground',
                )}
              >
                {decision}
              </span>
            )
          }
        >
          {pullRequest.reviewers.length > 0 ? (
            <ul className="flex flex-wrap gap-1">
              {pullRequest.reviewers.map(reviewer => (
                <li
                  key={reviewer.login}
                  className="rounded-md bg-accent px-1.5 py-0.5 text-2xs"
                >
                  {reviewer.login}
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
                <li
                  key={label}
                  className="rounded-full border px-1.5 py-0.5 text-2xs text-muted-foreground"
                >
                  {label}
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
          <ul className="space-y-px">
            {pullRequest.checkRuns.map((check, index) => (
              <li
                key={`${check.name}:${index}`}
                className="group flex h-6 items-center gap-2 rounded-md px-1.5 text-xs transition-colors duration-100 hover:bg-accent"
              >
                <CheckGlyph check={check} />
                <span className="min-w-0 flex-1 truncate" title={check.name}>
                  {check.name}
                </span>
                <span className="shrink-0 text-2xs text-muted-foreground capitalize">
                  {checkLabel(check)}
                </span>
                {check.url && (
                  <button
                    type="button"
                    aria-label={`Open check ${check.name}`}
                    onClick={() => check.url && openExternal(check.url)}
                    className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity duration-100 outline-none group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Description">
        {pullRequest.body.trim() ? (
          <MessageBody
            body={pullRequest.body}
            className="text-[13px] leading-6"
          />
        ) : (
          <p className="text-xs text-muted-foreground">No description.</p>
        )}
      </Section>
      {pullRequest.state === 'open' && (
        <Section title="Your review">
          <CommentBox
            label="Review comment"
            placeholder={
              event === 'approve'
                ? 'Optional note with the approval'
                : 'Leave a review comment'
            }
            value={body}
            onChange={value => {
              setBody(value);
              onReviewEdit();
            }}
            submitLabel="Submit review"
            canSubmit={canSubmit}
            state={reviewState}
            blockedReason={blockedReason}
            onSubmit={() => void submit()}
            controls={
              events.length > 1 && (
                <SegmentedControl
                  label="Review decision"
                  value={event}
                  options={events.map(value => ({
                    value,
                    label: REVIEW_EVENT_LABELS[value],
                  }))}
                  onChange={setChosen}
                  disabled={reviewState?.status === 'pending'}
                />
              )
            }
          />
        </Section>
      )}
    </div>
  );
}
