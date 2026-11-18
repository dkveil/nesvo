import { useEffect, useRef, useState } from 'react';
import type { DesktopApi, GitBranch } from '@nesvo/contracts';

type Props = {
  hostId: string;
  directory: string;
  enabled: boolean;
  api?: Pick<DesktopApi, 'readGitBranch'>;
};

const BRANCH_READ_DELAY_MS = 250;

export function useGitBranch({ hostId, directory, enabled, api }: Props) {
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
      latestApi.current?.readGitBranch({ directory }).then(
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
  return enabled && directory && branch?.key === key ? branch.value : null;
}
