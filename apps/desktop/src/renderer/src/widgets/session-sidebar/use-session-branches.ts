import { useEffect, useRef, useState } from 'react';
import type { Computer, GitBranch } from '@nesvo/contracts';
import type { Session } from '@/entities/session';

export type ReadBranch = (
  hostId: string,
  directory: string,
) => Promise<GitBranch>;

const branchKey = (hostId: string, directory: string) =>
  `${hostId}\u0000${directory}`;

export function useSessionBranches(
  sessions: Session[],
  computers: Computer[],
  readBranch: ReadBranch | undefined,
): (session: Session) => GitBranch | undefined {
  const [branches, setBranches] = useState<Record<string, GitBranch>>({});
  const [focusCount, setFocusCount] = useState(0);
  const latestRead = useRef(readBranch);
  useEffect(() => {
    latestRead.current = readBranch;
  });
  useEffect(() => {
    const refresh = () => setFocusCount(count => count + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const readable = computers
    .filter(
      computer =>
        computer.status === 'connected' &&
        computer.capabilities.includes('git-branch'),
    )
    .map(computer => computer.id);
  const keys = [
    ...new Set(
      sessions
        .filter(
          session => session.directory && readable.includes(session.hostId),
        )
        .map(session => branchKey(session.hostId, session.directory)),
    ),
  ].sort();
  const keyList = keys.join('\n');
  useEffect(() => {
    const read = latestRead.current;
    if (!read || !keyList) return;
    let current = true;
    for (const key of keyList.split('\n')) {
      const [hostId, directory] = key.split('\u0000');
      if (!hostId || !directory) continue;
      read(hostId, directory).then(
        value => {
          if (current) setBranches(previous => ({ ...previous, [key]: value }));
        },
        () => {
          if (current)
            setBranches(previous => ({ ...previous, [key]: { kind: 'none' } }));
        },
      );
    }
    return () => {
      current = false;
    };
  }, [keyList, focusCount]);
  return session => branches[branchKey(session.hostId, session.directory)];
}
