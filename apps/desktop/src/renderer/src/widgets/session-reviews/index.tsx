import { useEffect, useRef, useState, type Ref } from 'react';
import { ArrowUpRight, ClipboardCheck } from 'lucide-react';
import {
  fileKindLabels,
  reviewDate,
  reviewPreview,
  reviewStatusLabels,
  type Review,
} from '@/entities/review';
import { modelLabel } from '@/entities/session';
import { isDelegationReply } from '@/entities/session/delegation-reply';
import {
  ReviewDecision,
  type ReviewDecisionProps,
} from '@/features/review-decision';
import { Button } from '@/shared/ui/button';
import { NativeDisclosure } from '@/shared/ui/disclosure';
import { IconButton } from '@/shared/ui/icon-button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { StatusDot } from '@/shared/ui/status-dot';
import { ListRow } from '@/shared/ui/list-row';
import { entityKey, hostKey } from '@/shared/lib/host-key';

type Props = ReviewDecisionProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: Ref<HTMLButtonElement>;
  triggerSize: 24 | 32;
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
  latest: boolean;
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
  latest,
  onSession,
  onOpenDiff,
  ...decisionProps
}: VersionProps) {
  const [open, setOpen] = useOpenWhenFocused(focused);
  const status =
    review.status === 'changes-requested'
      ? 'Corrections'
      : reviewStatusLabels[review.status];
  const decision = (review.status === 'pending' ||
    decisionProps.feedbacks[entityKey(review)] ||
    decisionProps.decisionErrors[entityKey(review)]) && (
    <ReviewDecision review={review} {...decisionProps} size="xs" />
  );
  const details = (
    <div className="space-y-3">
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
      {!isDelegationReply(review.summary) && (
        <section aria-label="Result summary" className="space-y-2">
          <h4 className="text-xs font-medium">Summary</h4>
          <p className="text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {review.summary || 'No summary.'}
          </p>
        </section>
      )}
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
    </div>
  );
  return (
    <section
      id={`review-${review.id}`}
      aria-label={`Session result: version ${review.version}`}
      className="space-y-2"
    >
      {latest && (
        <>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">Version {review.version}</span>
            <span className="text-muted-foreground">{status}</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
            {reviewPreview(review)}
          </p>
          {decision}
        </>
      )}
      <NativeDisclosure
        lazyContent
        triggerLabel={`Open version ${review.version}`}
        title={latest ? 'Result details' : `Version ${review.version}`}
        meta={latest ? undefined : status}
        description={latest ? undefined : reviewPreview(review)}
        open={open}
        onOpenChange={setOpen}
        className="border-b py-1 last:border-b-0"
        contentClassName="space-y-3 px-2 pt-2 pb-3 text-foreground"
      >
        {details}
        {!latest && decision}
      </NativeDisclosure>
    </section>
  );
}

export function SessionReviews({
  open,
  onOpenChange,
  triggerRef,
  triggerSize,
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
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!open || !focusedId) return;
    const frame = requestAnimationFrame(() =>
      document
        .getElementById('review-' + focusedId)
        ?.scrollIntoView({ block: 'nearest' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [focusedId, open]);
  const focusedEarlier = earlier.some(review => review.id === focusedId);
  const [earlierOpen, setEarlierOpen] = useOpenWhenFocused(focusedEarlier);
  if (!latest) return null;
  const earlierLabel = `${earlier.length} earlier ${earlier.length === 1 ? 'version' : 'versions'}`;
  const renderVersion = (review: Review) => (
    <ReviewVersion
      key={review.id}
      review={review}
      allReviews={allReviews}
      focused={review.id === focusedId}
      latest={review.id === latest.id}
      onSession={onSession}
      onOpenDiff={onOpenDiff}
      {...decisionProps}
    />
  );
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <IconButton
          ref={triggerRef}
          size={triggerSize}
          label="Saved results"
          pressed={open}
          className="relative"
        >
          <ClipboardCheck />
          {latest.status === 'pending' && (
            <StatusDot tone="warning" className="absolute top-1 right-1" />
          )}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        onOpenAutoFocus={event => {
          event.preventDefault();
          title.current?.focus();
        }}
        side="bottom"
        align="end"
        size="lg"
        surface="solid"
        scroll
        aria-label="Saved results"
        className="space-y-3"
      >
        <h2
          ref={title}
          tabIndex={-1}
          className="border-b pb-2 text-xs font-medium outline-none"
        >
          Saved results
        </h2>
        {renderVersion(latest)}
        {earlier.length > 0 && (
          <NativeDisclosure
            lazyContent
            triggerLabel={earlierLabel}
            title={earlierLabel}
            variant="flat"
            open={earlierOpen}
            onOpenChange={setEarlierOpen}
            className="border-t pt-1"
            contentClassName="space-y-2 pt-1"
          >
            {earlier.map(renderVersion)}
          </NativeDisclosure>
        )}
      </PopoverContent>
    </Popover>
  );
}
