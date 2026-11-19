import { useEffect, useState } from 'react';
import type {
  Computer,
  ConfigurationArea,
  ConfigurationChange,
  HostId,
} from '@nesvo/contracts';

export type HostedConfigurationChange = ConfigurationChange & {
  hostId: HostId;
};

export function useConfigurationChanges(
  computers: Computer[],
  status?: ConfigurationChange['status'],
  area?: ConfigurationArea,
) {
  const ready = computers
    .filter(
      computer =>
        computer.status === 'connected' &&
        computer.capabilities.includes('configuration'),
    )
    .map(computer => computer.id)
    .join(',');
  const [changes, setChanges] = useState<
    Record<string, HostedConfigurationChange>
  >({});

  useEffect(() => {
    let current = true;
    const merge = (hostId: HostId, list: ConfigurationChange[]) => {
      if (!current) return;
      setChanges(previous => {
        const next = { ...previous };
        for (const change of list) {
          const key = `${hostId}/${change.id}`;
          if ((next[key]?.revision ?? 0) < change.revision)
            next[key] = { ...change, hostId };
        }
        return next;
      });
    };
    const unsubscribe = window.nesvo.subscribe(event => {
      if (event.type === 'configuration-changed')
        merge(event.hostId, [event.change]);
    });
    const load = async (hostId: HostId) => {
      let after: number | undefined;
      do {
        const result = await window.nesvo.configuration.history(
          { status, after, area },
          hostId,
        );
        if (!current || !result.ok || result.kind !== 'history') return;
        merge(hostId, result.page.changes);
        after =
          status === 'pending' ? (result.page.next ?? undefined) : undefined;
      } while (after !== undefined);
    };
    for (const id of ready.split(',').filter(Boolean))
      void load(id as HostId).catch(() => undefined);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [ready, status, area]);

  return Object.values(changes)
    .filter(
      change =>
        (!status || change.status === status) &&
        (!area || change.target.area === area) &&
        computers.some(computer => computer.id === change.hostId),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
