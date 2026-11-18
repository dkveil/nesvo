import type { ReactNode } from 'react';
import type { PullRequestReference } from '@nesvo/contracts';
import { GitPullRequest } from 'lucide-react';
import {
  ChecksIcon,
  checksLabels,
  PullRequestStateIcon,
  reviewDecisionLabels,
  usePullRequestDetails,
  visualState,
  visualStateLabels,
  type PullRequestApi,
} from '@/entities/pull-request';
import { DiffStat } from '@/entities/file-change';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';

type PullRequestCardProps = {
  hostId: string;
  reference: PullRequestReference;
  api: PullRequestApi | null;
  unavailableReason: string;
  actions?: ReactNode;
  onReview: (reference: PullRequestReference) => void;
  onOpen: (reference: PullRequestReference) => void;
};

const cardClasses =
  'flex min-w-0 items-center gap-2.5 rounded-surface border px-2.5 py-2';

function MetaDivider() {
  return <span aria-hidden="true">·</span>;
}

export function PullRequestCard({
  hostId,
  reference,
  api,
  unavailableReason,
  actions,
  onReview,
  onOpen,
}: PullRequestCardProps) {
  const details = usePullRequestDetails({
    hostId,
    reference,
    api,
    enabled: !unavailableReason,
  });
  const label = `${reference.repository} #${reference.number}`;
  const data = details.data;
  if (!data && details.status === 'loading')
    return (
      <div
        role="status"
        aria-label={`Loading pull request ${label}`}
        aria-busy="true"
        className={cardClasses}
      >
        <Skeleton shape="block" className="size-7" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="w-1/2" />
          <Skeleton className="w-1/3" />
        </div>
      </div>
    );
  if (!data)
    return (
      <p
        className="text-2xs text-muted-foreground [overflow-wrap:anywhere]"
        data-pull-request-card-fallback={`${reference.repository}#${reference.number}`}
      >
        Pull request {label}
        {details.error ? ' · Details are unavailable.' : ''}
      </p>
    );
  const state = visualState(data);
  const review = reviewDecisionLabels[data.reviewDecision];
  return (
    <section
      aria-label={`Pull request ${label}: ${data.title}`}
      data-pull-request-card={`${reference.repository}#${reference.number}`}
      className={cardClasses}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-accent">
        <PullRequestStateIcon state={state} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted-foreground tabular-nums">
            #{data.number}
          </span>
          <span className="min-w-0 truncate font-medium" title={data.title}>
            {data.title}
          </span>
        </p>
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs text-muted-foreground">
          <span>{visualStateLabels[state]}</span>
          <MetaDivider />
          <span className="flex items-center gap-1.5 tabular-nums">
            {data.changedFiles} {data.changedFiles === 1 ? 'file' : 'files'}
            <DiffStat additions={data.additions} deletions={data.deletions} />
          </span>
          {data.checks !== 'none' && (
            <>
              <MetaDivider />
              <span className="flex items-center gap-1">
                <ChecksIcon checks={data.checks} className="size-3" />
                {checksLabels[data.checks]}
              </span>
            </>
          )}
          {review && (
            <>
              <MetaDivider />
              <span>{review}</span>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={`Review pull request #${data.number}`}
          onClick={() => onReview(reference)}
        >
          <GitPullRequest />
          Review
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Open pull request #${data.number}`}
          onClick={() => onOpen(reference)}
        >
          Open
        </Button>
      </div>
    </section>
  );
}
