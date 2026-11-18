import { useState } from 'react';
import {
  codeReviewLimits,
  type DesktopApi,
  type PullRequestReference,
} from '@nesvo/contracts';
import { Bot } from 'lucide-react';
import { StartReviewDialog } from '@/features/code-review';
import { Button } from '@/shared/ui/button';
import { StatusMessage } from '@/shared/ui/status-message';

type ReviewSelectionBarProps = {
  api: Pick<DesktopApi, 'readCodeReviewSettings' | 'startPullRequestReview'>;
  hostId: string;
  selected: PullRequestReference[];
  full: boolean;
  directory: string;
  onDone: () => void;
  onOpenSettings?: () => void;
};

export function ReviewSelectionBar({
  api,
  hostId,
  selected,
  full,
  directory,
  onDone,
  onOpenSettings,
}: ReviewSelectionBarProps) {
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(0);
  return (
    <div
      role="toolbar"
      aria-label="Selected pull requests"
      className="flex flex-wrap items-center gap-2 rounded-surface border bg-card px-3 py-1.5"
    >
      <span className="text-xs tabular-nums">
        {selected.length
          ? `${selected.length} selected`
          : 'Select pull requests to review'}
      </span>
      {full && (
        <span className="text-2xs text-muted-foreground">
          Up to {codeReviewLimits.bulkReviews} at a time.
        </span>
      )}
      {started > 0 && (
        <StatusMessage tone="success">
          Started {started} {started === 1 ? 'review' : 'reviews'}. Each one
          runs as its own session in the sidebar.
        </StatusMessage>
      )}
      <span className="ml-auto flex items-center gap-1">
        <Button type="button" variant="ghost" size="xs" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={!selected.length}
          onClick={() => {
            setStarted(0);
            setStarting(true);
          }}
        >
          <Bot />
          Review with agent
        </Button>
      </span>
      {starting && (
        <StartReviewDialog
          open
          onOpenChange={setStarting}
          api={api}
          hostId={hostId}
          references={selected}
          defaultDirectory={directory}
          onStarted={drafts => setStarted(drafts.length)}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}
