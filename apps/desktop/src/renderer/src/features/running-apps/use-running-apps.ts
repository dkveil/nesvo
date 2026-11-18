import { useEffect, useMemo, useState } from 'react';
import type { Computer, RunningApp } from '@nesvo/contracts';
import { hostKey } from '@/shared/lib/host-key';

const POLL_INTERVAL_MS = 10_000;

export type RunningAppsBySession = ReadonlyMap<string, readonly RunningApp[]>;

const EMPTY: RunningAppsBySession = new Map();

type HostApps = Record<string, readonly RunningApp[]>;

export function useRunningApps(
  computers: readonly Computer[],
  enabled: boolean,
): RunningAppsBySession {
  const hostIds = computers
    .filter(
      computer =>
        computer.status === 'connected' &&
        computer.capabilities.includes('running-apps'),
    )
    .map(computer => computer.id)
    .join(' ');
  const [byHost, setByHost] = useState<HostApps>({});
  useEffect(() => {
    if (!enabled || !hostIds || !window.nesvo) return;
    const hosts = hostIds.split(' ');
    let cancelled = false;
    const poll = () => {
      if (document.visibilityState !== 'visible') return;
      for (const hostId of hosts)
        void window.nesvo
          .listRunningApps(hostId)
          .then(list => {
            if (!cancelled)
              setByHost(previous => ({ ...previous, [hostId]: list.apps }));
          })
          .catch(() => {
            if (!cancelled)
              setByHost(previous => {
                const next = { ...previous };
                delete next[hostId];
                return next;
              });
          });
    };
    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', poll);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [enabled, hostIds]);
  return useMemo(() => {
    if (!enabled || !hostIds) return EMPTY;
    const sessions = new Map<string, RunningApp[]>();
    for (const hostId of hostIds.split(' '))
      for (const app of byHost[hostId] ?? []) {
        const key = hostKey(app.sessionId, hostId);
        sessions.set(key, [...(sessions.get(key) ?? []), app]);
      }
    return sessions;
  }, [byHost, enabled, hostIds]);
}
