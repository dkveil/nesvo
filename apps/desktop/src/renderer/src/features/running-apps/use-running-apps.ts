import { useEffect, useMemo, useState } from 'react';
import type { Computer, DesktopSession, RunningApp } from '@nesvo/contracts';
import { hostKey } from '@/shared/lib/host-key';

const POLL_INTERVAL_MS = 10_000;

export type RunningAppsBySession = ReadonlyMap<string, readonly RunningApp[]>;

const EMPTY: RunningAppsBySession = new Map();

type HostApps = Record<string, readonly RunningApp[]>;

export function useRunningApps(
  computers: readonly Computer[],
  sessions: readonly DesktopSession[],
  sidebar: boolean,
  session: DesktopSession | null,
): RunningAppsBySession {
  const scope = !sidebar ? session?.id : undefined;
  const hostIds = computers
    .filter(
      computer =>
        (sidebar ||
          (computer.id === session?.hostId &&
            computer.capabilities.includes('running-apps-web'))) &&
        computer.status === 'connected' &&
        computer.capabilities.includes('running-apps'),
    )
    .map(computer =>
      computer.capabilities.includes('running-apps-web')
        ? computer.id + ':web'
        : computer.id,
    )
    .join(' ');
  const watchKey = JSON.stringify([hostIds, scope]);
  const [result, setResult] = useState<{
    key: string;
    byHost: HostApps;
  } | null>(null);
  useEffect(() => {
    if (!hostIds || !window.nesvo) return;
    const hosts = hostIds.split(' ');
    let cancelled = false;
    let timer: number | undefined;
    let polling = false;
    const poll = async () => {
      window.clearTimeout(timer);
      if (polling || cancelled || document.visibilityState !== 'visible')
        return;
      polling = true;
      const lists = await Promise.all(
        hosts.map(async host => {
          const [id, web] = host.split(':') as [string, string?];
          const apps = await window.nesvo
            .listRunningApps(id, web ? { sessionId: scope } : undefined)
            .then(
              list => list.apps,
              () => [],
            );
          return [id, apps] as const;
        }),
      );
      polling = false;
      if (cancelled) return;
      setResult({ key: watchKey, byHost: Object.fromEntries(lists) });
      if (document.visibilityState === 'visible')
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();
    document.addEventListener('visibilitychange', poll);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [hostIds, scope, watchKey]);
  return useMemo(() => {
    if (!hostIds || result?.key !== watchKey) return EMPTY;
    const parents = new Map(
      sessions.map(item => [hostKey(item.id, item.hostId), item.parentId]),
    );
    const appsBySession = new Map<string, RunningApp[]>();
    const add = (key: string, app: RunningApp) => {
      const apps = appsBySession.get(key);
      if (apps) apps.push(app);
      else appsBySession.set(key, [app]);
    };
    for (const [hostId, apps] of Object.entries(result.byHost))
      for (const app of apps) {
        const key = hostKey(app.sessionId, hostId);
        add(key, app);
        const parent = parents.get(key);
        if (parent) add(hostKey(parent, hostId), app);
      }
    return appsBySession;
  }, [hostIds, result, sessions, watchKey]);
}
