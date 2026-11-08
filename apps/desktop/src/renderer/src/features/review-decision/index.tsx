import { useState } from 'react';
import type { DecideReviewInput, Review } from '@/entities/review';
import { Button } from '@/shared/ui/button';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import { entityKey } from '@/shared/lib/host-key';

export type ReviewDecisionProps = {
  blockedReason: string;
  getBlockedReason?: (review: Review) => string;
  pending: Record<string, boolean>;
  decisionErrors: Record<string, string>;
  feedbacks: Record<string, string>;
  onFeedback: (reviewId: string, value: string) => void;
  onDecision: (
    review: Review,
    decision: DecideReviewInput['decision'],
    feedback: string,
  ) => void;
};

type Props = ReviewDecisionProps & { review: Review; compact?: boolean };

export function ReviewDecision({
  review,
  compact = false,
  blockedReason,
  getBlockedReason,
  pending,
  decisionErrors,
  feedbacks,
  onFeedback,
  onDecision,
}: Props) {
  const key = entityKey(review);
  const feedback = feedbacks[key] ?? '';
  const [expanded, setExpanded] = useState(!!feedback);
  const deciding = !!pending[key];
  const reason =
    review.status !== 'pending'
      ? 'This version is no longer awaiting a decision.'
      : getBlockedReason?.(review) || blockedReason;
  const disabled = !!reason || deciding;
  const unavailable = review.diff.status === 'unavailable';
  const feedbackId = `review-feedback-${key}`;
  const formId = `review-correction-${key}`;
  return (
    <div className={compact ? 'contents' : 'space-y-3'}>
      <div
        className={
          compact
            ? 'flex flex-wrap items-center gap-1.5 self-center md:col-start-2 md:row-start-1'
            : 'flex flex-wrap gap-2'
        }
      >
        <Button
          type="button"
          size="sm"
          variant={compact ? 'secondary' : 'default'}
          className={compact ? 'h-7 px-2.5 text-[13px] font-normal' : undefined}
          disabled={disabled || unavailable}
          title={reason || undefined}
          onClick={() => onDecision(review, 'accept', '')}
        >
          Accept result
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={
            compact
              ? 'h-7 px-2 text-[13px] font-normal text-muted-foreground'
              : undefined
          }
          disabled={disabled}
          title={reason || undefined}
          aria-expanded={expanded}
          aria-controls={formId}
          onClick={() => setExpanded(value => !value)}
        >
          Request changes
        </Button>
      </div>
      {expanded && (
        <form
          id={formId}
          className={compact ? 'col-span-full space-y-2 pt-2' : 'space-y-2'}
          onSubmit={event => {
            event.preventDefault();
            if (!disabled && feedback.trim())
              onDecision(review, 'request-changes', feedback.trim());
          }}
        >
          <Label htmlFor={feedbackId}>Feedback</Label>
          <Textarea
            id={feedbackId}
            value={feedback}
            onChange={event => onFeedback(key, event.target.value)}
            maxLength={8000}
            required
            placeholder="What needs to change?"
            aria-describedby={`${feedbackId}-help`}
            className="min-h-20"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p
              id={`${feedbackId}-help`}
              className="text-[11px] text-muted-foreground"
            >
              Starts a correction in this session.
            </p>
            <Button
              type="submit"
              size="sm"
              disabled={disabled || !feedback.trim()}
            >
              Send feedback
            </Button>
          </div>
        </form>
      )}
      {deciding && (
        <p
          role="status"
          className="col-span-full text-xs text-muted-foreground"
        >
          Saving decision…
        </p>
      )}
      {reason && review.status === 'pending' && !compact && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {reason}
        </p>
      )}
      {!reason && unavailable && (
        <p className="col-span-full text-[11px] text-muted-foreground">
          Diff unavailable. Request changes before accepting.
        </p>
      )}
      {decisionErrors[key] && (
        <p
          role="alert"
          className="col-span-full text-sm leading-relaxed whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]"
        >
          {decisionErrors[key]}
        </p>
      )}
    </div>
  );
}
