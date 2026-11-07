import { useEffect, useRef } from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import {
  fileKindLabels,
  reviewDate,
  reviewPreview,
  reviewStatusLabels,
  type Review,
} from '@/entities/review';
import { modelLabel } from '@/entities/session';
import {
  ReviewDecision,
  type ReviewDecisionProps,
} from '@/features/review-decision';
import { Button } from '@/shared/ui/button';

type Props = ReviewDecisionProps & {
  reviews: Review[];
  allReviews: Review[];
  focusedId: string;
  onSession: (sessionId: string, targetId?: string) => void;
  onOpenDiff: (reviewId: string, path?: string) => void;
};

type VersionProps = ReviewDecisionProps & {
  review: Review;
  allReviews: Review[];
  focused: boolean;
  onSession: (sessionId: string, targetId?: string) => void;
  onOpenDiff: (reviewId: string, path?: string) => void;
};

function ReviewVersion({
  review,
  allReviews,
  focused,
  onSession,
  onOpenDiff,
  ...decisionProps
}: VersionProps) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (focused && disclosure.current) disclosure.current.open = true;
  }, [focused]);
  return (
    <details
      ref={disclosure}
      id={`review-${review.id}`}
      role="region"
      aria-label={`Session result: version ${review.version}`}
      className="group/review border-b border-border/70 last:border-b-0"
    >
      <summary
        aria-label={`Open version ${review.version}`}
        className="cursor-pointer list-none py-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden"
      >
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">Version {review.version}</span>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span>{reviewStatusLabels[review.status]}</span>
            <ChevronDown className="size-3.5 transition-transform group-open/review:rotate-180" />
          </span>
        </span>
        <span className="mt-2 block text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {reviewPreview(review)}
        </span>
      </summary>
      <div className="space-y-5 pb-5">
        <header className="space-y-2">
          <h3 className="text-sm font-medium [overflow-wrap:anywhere]">
            {review.title}
          </h3>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {review.role === 'worker'
              ? 'Worker · '
              : review.dependencies.length > 0
                ? 'Orchestrator · '
                : ''}{' '}
            {review.provider} · {modelLabel(review.model)} ·{' '}
            <time dateTime={review.createdAt}>
              {reviewDate(review.createdAt)}
            </time>
          </p>
        </header>
        <section className="space-y-2">
          <h4 className="text-xs font-medium">Task</h4>
          <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
            {review.task}
          </p>
          {review.scope && (
            <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              Scope: {review.scope}
            </p>
          )}
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            Working directory: {review.directory}
          </p>
        </section>
        <section aria-label="Result summary" className="space-y-2">
          <h4 className="text-xs font-medium">Summary</h4>
          <p className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {review.summary || 'No summary.'}
          </p>
        </section>
        <section aria-label="File changes" className="space-y-3">
          <h4 className="text-xs font-medium">File changes</h4>
          {review.diff.status !== 'not-applicable' && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Changes between the start and end of this turn. Concurrent edits
              outside the session may also appear.
            </p>
          )}
          {review.diff.status === 'not-applicable' ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {review.diff.detail ??
                'This read-only result has no file changes. You can accept the summary.'}
            </p>
          ) : review.diff.status === 'unavailable' ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {review.diff.detail ??
                'A complete diff is unavailable. Request changes before accepting this result.'}
            </p>
          ) : (
            <>
              {review.diff.detail && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {review.diff.detail}
                </p>
              )}
              {review.diff.files.length > 0 ? (
                <ul className="max-h-48 divide-y overflow-auto border-y">
                  {review.diff.files.map(file => (
                    <li key={file.path} className="text-xs">
                      <button
                        type="button"
                        className="flex w-full items-start justify-between gap-3 py-2 text-left hover:text-foreground focus-visible:outline-ring"
                        onClick={() => onOpenDiff(review.id, file.path)}
                      >
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          {file.path}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {fileKindLabels[file.kind]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No file changes were recorded.
                </p>
              )}
            </>
          )}
          {review.diff.patch && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`View diff for version ${review.version}`}
              onClick={() => onOpenDiff(review.id)}
            >
              View diff
              <ArrowUpRight className="size-3.5" />
            </Button>
          )}
        </section>
        {review.dependencies.length > 0 && (
          <section className="space-y-2">
            <h4 className="text-xs font-medium">Worker results</h4>
            <div className="flex flex-wrap gap-2">
              {review.dependencies.map(dependency => {
                const source = allReviews.find(
                  item => item.id === dependency.reviewId,
                );
                return (
                  <Button
                    key={dependency.reviewId}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto min-w-0 py-1.5 whitespace-normal [overflow-wrap:anywhere]"
                    onClick={() =>
                      onSession(
                        dependency.sessionId,
                        `review-${dependency.reviewId}`,
                      )
                    }
                  >
                    {source?.title ?? 'Worker result'} · version{' '}
                    {dependency.version}
                    <ArrowUpRight className="size-3 shrink-0" />
                  </Button>
                );
              })}
            </div>
          </section>
        )}
        {review.decision && (
          <section
            aria-label="Saved decision"
            className="space-y-2 border-t pt-4"
          >
            <h4 className="text-xs font-medium">Your decision</h4>
            <p className="text-sm">
              {review.decision.decision === 'accept'
                ? 'This version was accepted.'
                : 'Changes were requested for this version.'}
            </p>
            <time
              className="text-xs text-muted-foreground"
              dateTime={review.decision.at}
            >
              {reviewDate(review.decision.at)}
            </time>
            {review.decision.feedback && (
              <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                {review.decision.feedback}
              </p>
            )}
          </section>
        )}
        {(review.status === 'pending' ||
          decisionProps.feedbacks[review.id] ||
          decisionProps.decisionErrors[review.id]) && (
          <ReviewDecision review={review} {...decisionProps} />
        )}
      </div>
    </details>
  );
}

export function SessionReviews({
  reviews,
  allReviews,
  focusedId,
  onSession,
  onOpenDiff,
  ...decisionProps
}: Props) {
  if (reviews.length === 0) return null;
  const versions = [...reviews].sort(
    (left, right) =>
      right.version - left.version ||
      right.createdAt.localeCompare(left.createdAt),
  );
  return (
    <section aria-label="Session results" className="space-y-2 border-t pt-5">
      <h2 className="text-sm font-medium">Session results</h2>
      <div>
        {versions.map(review => (
          <ReviewVersion
            key={review.id}
            review={review}
            allReviews={allReviews}
            focused={review.id === focusedId}
            onSession={onSession}
            onOpenDiff={onOpenDiff}
            {...decisionProps}
          />
        ))}
      </div>
    </section>
  );
}
