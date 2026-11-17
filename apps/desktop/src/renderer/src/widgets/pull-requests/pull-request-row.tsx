import type { PullRequestSummary } from '@nesvo/contracts';
import { cn } from 'cn';
import {
  ChecksIcon,
  PullRequestStateIcon,
  visualState,
  visualStateLabels,
} from '@/entities/pull-request';
import { formatRelativeTime } from '@/shared/lib/relative-time';

type PullRequestRowProps = {
  pullRequest: PullRequestSummary;
  selected: boolean;
  now: number;
  onOpen: () => void;
};

export function PullRequestRow({
  pullRequest,
  selected,
  now,
  onOpen,
}: PullRequestRowProps) {
  const state = visualState(pullRequest);
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        aria-label={`${visualStateLabels[state]} pull request #${pullRequest.number}: ${pullRequest.title}`}
        onClick={onOpen}
        className={cn(
          'grid h-[2.375rem] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-3 text-left transition-colors duration-150 ease-out outline-none',
          'hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset',
          selected &&
            'bg-sidebar-row-selected shadow-(--sidebar-row-selected-shadow) hover:bg-sidebar-row-selected',
        )}
      >
        <PullRequestStateIcon state={state} className="row-span-2 self-start" />
        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4">
          <span className="shrink-0 text-muted-foreground tabular-nums">
            #{pullRequest.number}
          </span>
          <span className="truncate font-medium text-foreground">
            {pullRequest.title}
          </span>
          <ChecksIcon checks={pullRequest.checks} />
        </span>
        <span className="row-span-2 flex flex-col items-end gap-0.5 text-2xs leading-none tabular-nums">
          <span className="flex gap-1.5 font-mono">
            <span className="text-success-foreground">
              +{pullRequest.additions}
            </span>
            <span className="text-error-foreground">
              −{pullRequest.deletions}
            </span>
          </span>
          <time
            dateTime={pullRequest.updatedAt}
            title={new Date(pullRequest.updatedAt).toLocaleString()}
            className="text-muted-foreground"
          >
            {formatRelativeTime(pullRequest.updatedAt, now)}
          </time>
        </span>
        <span className="flex min-w-0 items-center gap-1 text-2xs leading-4 text-muted-foreground">
          <span className="max-w-32 shrink-0 truncate">
            {pullRequest.author?.login ?? 'unknown'}
          </span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate font-mono">
            {pullRequest.headRefName}
          </span>
          <span aria-hidden="true">→</span>
          <span className="max-w-28 shrink-0 truncate font-mono">
            {pullRequest.baseRefName}
          </span>
        </span>
      </button>
    </li>
  );
}
