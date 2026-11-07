import { useState } from 'react';
import type { DecideReviewInput, Review } from '@/entities/review';
import { Button } from '@/shared/ui/button';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';

export type ReviewDecisionProps = {
  blockedReason: string;
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

type Props = ReviewDecisionProps & { review: Review };

export function ReviewDecision({
  review,
  blockedReason,
  pending,
  decisionErrors,
  feedbacks,
  onFeedback,
  onDecision,
}: Props) {
  const feedback = feedbacks[review.id] ?? '';
  const [expanded, setExpanded] = useState(!!feedback);
  const deciding = !!pending[review.id];
  const reason =
    review.status !== 'pending'
      ? 'Ta wersja nie oczekuje na decyzję.'
      : blockedReason;
  const disabled = !!reason || deciding;
  const unavailable = review.diff.status === 'unavailable';
  const feedbackId = `review-feedback-${review.id}`;
  const formId = `review-correction-${review.id}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={disabled || unavailable}
          onClick={() => onDecision(review, 'accept', '')}
        >
          Zaakceptuj wynik
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-expanded={expanded}
          aria-controls={formId}
          onClick={() => setExpanded(value => !value)}
        >
          Odeślij do poprawy
        </Button>
      </div>
      {expanded && (
        <form
          id={formId}
          className="space-y-2"
          onSubmit={event => {
            event.preventDefault();
            if (!disabled && feedback.trim())
              onDecision(review, 'request-changes', feedback.trim());
          }}
        >
          <Label htmlFor={feedbackId}>Uwagi do poprawy</Label>
          <Textarea
            id={feedbackId}
            value={feedback}
            onChange={event => onFeedback(review.id, event.target.value)}
            maxLength={8000}
            required
            placeholder="Opisz, co wymaga poprawy…"
            aria-describedby={`${feedbackId}-help`}
            className="min-h-20"
          />
          <p
            id={`${feedbackId}-help`}
            className="text-xs leading-relaxed text-muted-foreground"
          >
            Wysłanie uwag uruchomi poprawę w tej samej sesji.
          </p>
          <Button
            type="submit"
            size="sm"
            disabled={disabled || !feedback.trim()}
          >
            Wyślij uwagi
          </Button>
        </form>
      )}
      {deciding && (
        <p role="status" className="text-xs text-muted-foreground">
          Zapisywanie decyzji…
        </p>
      )}
      {reason && review.status === 'pending' && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {reason}
        </p>
      )}
      {!reason && unavailable && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Akceptacja wymaga pełnego porównania zmian. Możesz odesłać wynik do
          poprawy.
        </p>
      )}
      {decisionErrors[review.id] && (
        <p
          role="alert"
          className="text-sm leading-relaxed whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]"
        >
          {decisionErrors[review.id]}
        </p>
      )}
    </div>
  );
}
