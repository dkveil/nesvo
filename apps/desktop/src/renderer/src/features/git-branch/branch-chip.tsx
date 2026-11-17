import { useEffect, useRef, useState } from 'react';
import { GitBranch as GitBranchIcon } from 'lucide-react';
import type { DesktopApi, GitBranch } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import { Chip } from '@/shared/ui/chip';
import { Hint } from '@/shared/ui/tooltip';

type Props = {
  hostId: string;
  directory: string;
  enabled: boolean;
  api: Pick<DesktopApi, 'readGitBranch'>;
};

const BRANCH_READ_DELAY_MS = 250;

export function BranchChip({ hostId, directory, enabled, api }: Props) {
  const [branch, setBranch] = useState<{
    key: string;
    value: GitBranch;
  } | null>(null);
  const [focusCount, setFocusCount] = useState(0);
  const latestApi = useRef(api);
  useEffect(() => {
    latestApi.current = api;
  });
  const key = `${hostId}\u0000${directory}`;
  useEffect(() => {
    const refresh = () => setFocusCount(count => count + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    if (!enabled || !directory) return;
    let current = true;
    const timer = setTimeout(() => {
      latestApi.current.readGitBranch({ directory }).then(
        value => {
          if (current) setBranch({ key, value });
        },
        () => {
          if (current) setBranch({ key, value: { kind: 'none' } });
        },
      );
    }, BRANCH_READ_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [directory, enabled, key, focusCount]);
  const shown =
    enabled && directory && branch?.key === key ? branch.value : null;
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
