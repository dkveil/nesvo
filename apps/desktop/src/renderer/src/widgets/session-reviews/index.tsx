import { useState, type ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
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
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { ListRow } from '@/shared/ui/list-row';
import { entityKey, hostKey } from '@/shared/lib/host-key';

type Props = ReviewDecisionProps & {
  pullRequest?: ReactNode;
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

function useOpenWhenFocused(focused: boolean) {
  const [open, setOpen] = useState(focused);
  const [wasFocused, setWasFocused] = useState(focused);
  if (focused !== wasFocused) {
    setWasFocused(focused);
    if (focused) setOpen(true);
  }
  return [open, setOpen] as const;
}

function ReviewVersion({
  review,
  allReviews,
  focused,
  onSession,
  onOpenDiff,
  ...decisionProps
}: VersionProps) {
  const [open, setOpen] = useOpenWhenFocused(focused);
  return (
    <NativeDisclosure
      id={`review-${review.id}`}
      role="region"
      aria-label={`Session result: version ${review.version}`}
      triggerLabel={`Open version ${review.version}`}
      title={`Version ${review.version}`}
      meta={reviewStatusLabels[review.status]}
      description={reviewPreview(review)}
      open={open}
      onOpenChange={setOpen}
      className="border-b py-1.5 last:border-b-0"
      contentClassName="space-y-5 pt-3 pr-2 pb-4 text-foreground"
    >
      <header className="space-y-1">
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
      <section aria-label="File changes" className="space-y-2">
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
              <ul className="-mx-2 max-h-48 overflow-y-auto">
                {review.diff.files.map(file => (
                  <li key={file.path}>
                    <ListRow
                      title={file.path}
                      trailing={fileKindLabels[file.kind]}
                      onClick={() => onOpenDiff(review.id, file.path)}
                    />
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
            aria-label={`View diff for version ${review.version}`}
            onClick={() => onOpenDiff(review.id)}
          >
            View diff
            <ArrowUpRight />
          </Button>
        )}
      </section>
      {review.dependencies.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-xs font-medium">Worker results</h4>
          <div className="flex flex-wrap gap-2">
            {review.dependencies.map(dependency => {
              const source = allReviews.find(
                item =>
                  item.id === dependency.reviewId &&
                  item.hostId === review.hostId,
              );
              return (
                <Button
                  key={dependency.reviewId}
                  type="button"
                  variant="outline"
                  className="max-w-full"
                  onClick={() =>
                    onSession(
                      hostKey(dependency.sessionId, review.hostId),
                      `review-${dependency.reviewId}`,
                    )
                  }
                >
                  <span className="truncate">
                    {source?.title ?? 'Worker result'} · version{' '}
                    {dependency.version}
                  </span>
                  <ArrowUpRight />
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
              : review.decision.decision === 'reject'
                ? 'This version was rejected.'
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
        decisionProps.feedbacks[entityKey(review)] ||
        decisionProps.decisionErrors[entityKey(review)]) && (
        <ReviewDecision review={review} {...decisionProps} />
      )}
    </NativeDisclosure>
  );
}

export function SessionReviews({
  pullRequest,
  reviews,
  allReviews,
  focusedId,
  onSession,
  onOpenDiff,
  ...decisionProps
}: Props) {
  const versions = [...reviews].sort(
    (left, right) =>
      right.version - left.version ||
      right.createdAt.localeCompare(left.createdAt),
  );
  const [latest, ...earlier] = versions;
  const focusedEarlier = earlier.some(review => review.id === focusedId);
  const [earlierOpen, setEarlierOpen] = useOpenWhenFocused(focusedEarlier);
  if (reviews.length === 0 && !pullRequest) return null;
  const earlierLabel = `${earlier.length} earlier ${earlier.length === 1 ? 'version' : 'versions'}`;
  const renderVersion = (review: Review) => (
    <ReviewVersion
      key={review.id}
      review={review}
      allReviews={allReviews}
      focused={review.id === focusedId}
      onSession={onSession}
      onOpenDiff={onOpenDiff}
      {...decisionProps}
    />
  );
  return (
    <section aria-label="Session results" className="space-y-2 border-t pt-5">
      <h2 className="text-sm font-medium">Session results</h2>
      {pullRequest}
      <div className="-mx-2 empty:hidden">
        {latest && renderVersion(latest)}
        {earlier.length > 0 && (
          <NativeDisclosure
            triggerLabel={earlierLabel}
            title={earlierLabel}
            open={earlierOpen}
            onOpenChange={setEarlierOpen}
            className="pt-1.5"
            contentClassName="pl-0"
          >
            {earlier.map(renderVersion)}
          </NativeDisclosure>
        )}
      </div>
    </section>
  );
}
