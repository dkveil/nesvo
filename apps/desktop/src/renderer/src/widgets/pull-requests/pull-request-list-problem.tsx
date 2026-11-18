import type { LucideIcon } from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import { Disclosure } from '@/shared/ui/disclosure';
import { EmptyState } from '@/shared/ui/empty-state';

type PullRequestListProblemProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  details?: string;
  onTrack?: () => void;
  onRetry?: () => void;
};

export function PullRequestListProblem({
  icon,
  title,
  description,
  details,
  onTrack,
  onRetry,
}: PullRequestListProblemProps) {
  return (
    <div className="space-y-2">
      <EmptyState
        size="sm"
        icon={icon}
        title={title}
        description={description}
        action={
          (onTrack || onRetry) && (
            <>
              {onTrack && (
                <Button
                  type="button"
                  size="sm"
                  aria-haspopup="dialog"
                  onClick={onTrack}
                >
                  Track a repository
                </Button>
              )}
              {onRetry && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onRetry}
                >
                  Try again
                </Button>
              )}
            </>
          )
        }
      />
      {details && (
        <Disclosure
          title="Details"
          className="mx-auto max-w-md"
          contentClassName="pt-1"
        >
          <CodeBlock code={details} wrap copyable={false} />
        </Disclosure>
      )}
    </div>
  );
}
