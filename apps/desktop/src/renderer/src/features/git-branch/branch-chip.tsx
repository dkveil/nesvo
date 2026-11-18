import { GitBranch as GitBranchIcon, GitFork } from 'lucide-react';
import type { GitBranch, SessionWorktree } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { Chip } from '@/shared/ui/chip';
import { Hint } from '@/shared/ui/tooltip';

export function BranchChip({
  branch,
  worktree,
}: {
  branch: GitBranch | null;
  worktree?: SessionWorktree;
}) {
  if (worktree)
    return (
      <Hint label={`Session worktree · ${worktree.branch}`}>
        <Chip
          interactive={false}
          size="sm"
          data-branch-kind="worktree"
          icon={<GitFork aria-hidden="true" />}
          className="max-w-48"
        >
          <span className="sr-only">Worktree branch </span>
          <span>{worktree.branch}</span>
        </Chip>
      </Hint>
    );
  const shown = branch;
  if (!shown || shown.kind === 'none') return null;
  const detached = shown.kind === 'detached';
  const label = detached
    ? `Detached HEAD at ${shown.sha}`
    : `Git branch ${shown.name}`;
  return (
    <Hint label={label}>
      <Chip
        interactive={false}
        size="sm"
        data-branch-kind={shown.kind}
        icon={<GitBranchIcon aria-hidden="true" />}
        className="max-w-48"
      >
        <span className="sr-only">
          {detached ? 'Detached HEAD at ' : 'Git branch '}
        </span>
        <span className={cn(detached && 'font-mono')}>
          {detached ? shown.sha : shown.name}
        </span>
      </Chip>
    </Hint>
  );
}
