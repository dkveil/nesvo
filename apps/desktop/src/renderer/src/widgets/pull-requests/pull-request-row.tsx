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
            {pullRequest.author?.login ?? 'unknown'} ·{' '}
            <span className="font-mono">
              {pullRequest.headRefName} → {pullRequest.baseRefName}
            </span>
          </>
        }
        trailing={
          <>
            <ChecksIcon checks={pullRequest.checks} className="size-3.5" />
            <span className="flex flex-col items-end gap-0.5">
              <DiffStat
                additions={pullRequest.additions}
                deletions={pullRequest.deletions}
              />
              <RelativeTime at={pullRequest.updatedAt} now={now} />
            </span>
          </>
        }
      />
    </li>
  );
}
