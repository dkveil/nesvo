import { useState } from 'react';
import type { DecideReviewInput, Review } from '@/entities/review';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { StatusMessage } from '@/shared/ui/status-message';
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
  const fullWidth = compact && 'col-span-full';
  return (
    <div className={compact ? 'contents' : 'space-y-2'}>
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5',
          compact && 'col-start-2 row-start-1 self-center',
        )}
      >
        <Button
          type="button"
          variant={compact ? 'secondary' : 'default'}
          disabled={disabled || unavailable}
          onClick={() => onDecision(review, 'accept', '')}
        >
          Accept result
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
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
          className={cn(fullWidth, compact && 'pt-1.5')}
          onSubmit={event => {
            event.preventDefault();
            if (!disabled && feedback.trim())
              onDecision(review, 'request-changes', feedback.trim());
          }}
        >
          <Composer variant="compact">
            <ComposerInput
              id={feedbackId}
              aria-label="Feedback"
              value={feedback}
              onChange={event => onFeedback(key, event.target.value)}
              maxLength={8000}
              required
              placeholder="What needs to change?"
              aria-describedby={`${feedbackId}-help`}
            />
            <ComposerToolbar
              start={
                <span id={`${feedbackId}-help`}>
                  Starts a correction in this session.
                </span>
              }
              end={
                <ComposerSend
                  label="Send feedback"
                  disabled={disabled || !feedback.trim()}
                />
              }
            />
          </Composer>
        </form>
      )}
      {deciding && (
        <StatusMessage tone="loading" className={fullWidth || undefined}>
          Saving decision…
        </StatusMessage>
      )}
      {reason && review.status === 'pending' && !compact && (
        <StatusMessage>{reason}</StatusMessage>
      )}
      {!reason && unavailable && (
        <StatusMessage tone="warning" className={fullWidth || undefined}>
          Diff unavailable. Request changes before accepting.
        </StatusMessage>
      )}
      {decisionErrors[key] && (
        <StatusMessage
          tone="error"
          className={cn('whitespace-pre-wrap', fullWidth)}
        >
          {decisionErrors[key]}
        </StatusMessage>
      )}
    </div>
  );
}
