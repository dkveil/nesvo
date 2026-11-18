import type { PullRequestSummary } from '@nesvo/contracts';
import {
  ChecksIcon,
  PullRequestStateIcon,
  RelativeTime,
  visualState,
  visualStateLabels,
} from '@/entities/pull-request';
import { DiffStat } from '@/entities/file-change';
import { ListRow } from '@/shared/ui/list-row';

type PullRequestRowProps = {
  pullRequest: PullRequestSummary;
  selected: boolean;
  now: number;
  showRepository?: boolean;
  onOpen: () => void;
};

export function PullRequestRow({
  pullRequest,
  selected,
  now,
  showRepository = false,
  onOpen,
}: PullRequestRowProps) {
  const state = visualState(pullRequest);
  return (
    <li>
      <ListRow
        density="two-line"
        selected={selected}
        onClick={onOpen}
        mainProps={{
          'aria-label': `${visualStateLabels[state]} pull request #${pullRequest.number}: ${pullRequest.title}`,
        }}
        leading={<PullRequestStateIcon state={state} />}
        title={
          <>
            <span className="font-normal text-muted-foreground tabular-nums">
              #{pullRequest.number}
            </span>{' '}
            {pullRequest.title}
          </>
        }
        description={
          <>
            {showRepository && `${pullRequest.repository} · `}
            {pullRequest.author?.login ?? 'unknown'} ·{' '}
            <span className="font-mono">
              {pullRequest.headRefName} → {pullRequest.baseRefName}
            </span>
          </>
        }
        trailing={
          <span className="flex items-center gap-3">
            <span className="flex size-3.5 items-center justify-center">
              <ChecksIcon checks={pullRequest.checks} className="size-3.5" />
            </span>
            <DiffStat
              additions={pullRequest.additions}
              deletions={pullRequest.deletions}
              className="min-w-20 justify-end"
            />
            <RelativeTime
              at={pullRequest.updatedAt}
              now={now}
              className="w-8 text-right tabular-nums"
            />
          </span>
        }
      />
    </li>
  );
}
