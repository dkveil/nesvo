import type { PullRequestReference } from '@nesvo/contracts';
import { GitPullRequest } from 'lucide-react';
import {
  checksLabels,
  PullRequestStateIcon,
  usePullRequestDetails,
  visualState,
  visualStateLabels,
  type PullRequestApi,
} from '@/entities/pull-request';
import { checksDotTones } from '@/features/session-pull-request/checks-dot-tones';
import { cardSection } from '@/shared/ui/card-row-styles';
import { ListRow } from '@/shared/ui/list-row';
import { StatusDot } from '@/shared/ui/status-dot';
import { cardRowProps } from './card-row';

type PullRequestSectionProps = {
  hostId: string;
  reference: PullRequestReference;
  api: PullRequestApi | null;
  unavailableReason: string;
  onReview: () => void;
};

export function PullRequestSection({
  hostId,
  reference,
  api,
  unavailableReason,
  onReview,
}: PullRequestSectionProps) {
  const { data } = usePullRequestDetails({
    hostId,
    reference,
    api,
    enabled: !unavailableReason,
  });
  const state = data ? visualState(data) : null;
  const checks = data && data.checks !== 'none' ? data.checks : null;
  return (
    <div className={cardSection} data-session-card-pull-request="">
      <ListRow
        leading={
          state ? <PullRequestStateIcon state={state} /> : <GitPullRequest />
        }
        title={
          <>
            <span className="text-muted-foreground tabular-nums">
              #{reference.number}
            </span>{' '}
            {data?.title ?? reference.repository}
          </>
        }
        trailing={
          <span className="flex items-center gap-1.5">
            {state && visualStateLabels[state]}
            {checks && <StatusDot tone={checksDotTones[checks]} />}
          </span>
        }
        mainProps={{
          ...cardRowProps,
          'aria-label': [
            `Review pull request #${reference.number}`,
            data?.title,
            state && visualStateLabels[state],
            checks && checksLabels[checks],
          ]
            .filter(Boolean)
            .join(', '),
        }}
        onClick={onReview}
      />
    </div>
  );
}
