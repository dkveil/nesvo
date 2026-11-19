import { useEffect, useState } from 'react';
import type {
  Computer,
  CoordinatorWakeState,
  DesktopSession,
} from '@nesvo/contracts';
import { entityKey, hostKey } from '@/shared/lib/host-key';

type WakeTarget = [
  id: string,
  runId: string | null,
  status: DesktopSession['status'],
];
type WakeHost = [
  hostId: string,
  identity: string | null,
  online: boolean,
  sessions: WakeTarget[],
];

const wakeKey = (key: string, identity: string | null) =>
  JSON.stringify([key, identity]);

export function useFlowWake(
  computers: Computer[],
  sessions: DesktopSession[],
  enabled: boolean,
) {
  const [known, setKnown] = useState<Record<string, CoordinatorWakeState>>({});
  const parents = new Set(
    sessions.flatMap(session =>
      session.parentId && !session.archivedAt
        ? [hostKey(session.parentId, session.hostId)]
        : [],
    ),
  );
  const coordinators = sessions.filter(
    session => !session.archivedAt && parents.has(entityKey(session)),
  );
  const hosts: WakeHost[] = enabled
    ? computers.flatMap(computer => {
        if (
          computer.status === 'connected'
            ? !computer.capabilities.includes('coordinator-orchestration')
            : computer.kind !== 'ssh' || !computer.lastSyncedAt
        )
          return [];
        const targets: WakeTarget[] = coordinators
          .filter(session => session.hostId === computer.id)
          .map(session => [session.id, session.runId, session.status]);
        targets.sort(([left], [right]) => left.localeCompare(right));
        return targets.length
          ? [
              [
                computer.id,
                computer.instanceId,
                computer.status === 'connected',
                targets,
              ],
            ]
          : [];
      })
    : [];
  const signature = JSON.stringify(hosts);

  useEffect(() => {
    const selected = JSON.parse(signature) as WakeHost[];
    if (!selected.length) return;
    const api = window.nesvo;
    const generations = new Map<string, number>();
    let current = true;
    const refresh = async ([hostId, identity, , targets]: WakeHost) => {
      const generation = (generations.get(hostId) ?? 0) + 1;
      generations.set(hostId, generation);
      const replies = await Promise.allSettled(
        targets.map(
          async ([sessionId]) =>
            [
              wakeKey(hostKey(sessionId, hostId), identity),
              await api.readCoordinatorWake({ sessionId }, hostId),
            ] as const,
        ),
      );
      if (!current || generations.get(hostId) !== generation) return;
      const updates = replies.flatMap(reply =>
        reply.status === 'fulfilled' ? [reply.value] : [],
      );
      if (updates.length)
        setKnown(previous => ({ ...previous, ...Object.fromEntries(updates) }));
    };
    const unsubscribe = api.subscribe(event => {
      if (event.type !== 'coordinator-wake-changed') return;
      const host = selected.find(
        ([hostId, , online]) => online && hostId === event.hostId,
      );
      if (host) void refresh(host);
    });
    for (const host of selected) void refresh(host);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [signature]);

  return new Map(
    coordinators.flatMap(session => {
      const computer = computers.find(item => item.id === session.hostId);
      if (!computer) return [];
      const key = entityKey(session);
      const state = known[wakeKey(key, computer.instanceId)];
      return state ? [[key, state]] : [];
    }),
  );
}
