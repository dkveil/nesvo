import type { ComponentProps } from 'react';
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from 'lucide-react';
import { cn } from 'cn';
import type { PullRequestVisualState } from './index';

const STATE_ICONS = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const;

const STATE_TONES: Record<PullRequestVisualState, string> = {
  open: 'text-pr-open',
  draft: 'text-pr-draft',
  merged: 'text-pr-merged',
  closed: 'text-pr-closed',
};

type PullRequestStateIconProps = ComponentProps<'svg'> & {
  state: PullRequestVisualState;
};

export function PullRequestStateIcon({
  state,
  className,
  ...props
}: PullRequestStateIconProps) {
  const Icon = STATE_ICONS[state];
  return (
    <Icon
      aria-hidden="true"
      className={cn('size-3.5 shrink-0', STATE_TONES[state], className)}
      {...props}
    />
  );
}
