import type { PullRequest } from '@nesvo/contracts';

type MergeHint = {
  label: string;
  tone: 'success' | 'warning' | 'error' | 'muted';
};

const STATUS_HINTS: Record<string, MergeHint> = {
  clean: { label: 'Ready to merge', tone: 'success' },
  has_hooks: { label: 'Ready to merge', tone: 'success' },
  unstable: { label: 'Checks not passing', tone: 'warning' },
  blocked: { label: 'Blocked by branch rules', tone: 'warning' },
  behind: { label: 'Behind the base branch', tone: 'warning' },
  dirty: { label: 'Merge conflicts', tone: 'error' },
  draft: { label: 'Draft', tone: 'muted' },
};

export function mergeHint(pullRequest: PullRequest): MergeHint | null {
  if (pullRequest.state !== 'open') return null;
  if (pullRequest.mergeable === 'conflicting')
    return { label: 'Merge conflicts', tone: 'error' };
  const known = STATUS_HINTS[pullRequest.mergeStateStatus.toLowerCase()];
  if (known) return known;
  return pullRequest.mergeable === 'unknown'
    ? { label: 'Checking mergeability', tone: 'muted' }
    : null;
}
