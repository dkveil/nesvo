import { useEffect, useState } from 'react';
import type { Computer, ProviderProfile } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { desktopApi } from './use-sessions';

export type ProfileCatalog = { profiles: ProviderProfile[]; error?: string };

export function useProviderProfiles(computers: Computer[]) {
  const [catalogs, setCatalogs] = useState<Record<string, ProfileCatalog>>({});
  const available = JSON.stringify(
    computers
      .filter(
        computer =>
          computer.status === 'connected' &&
          computer.capabilities.includes('provider-profiles'),
      )
      .map(computer => [computer.id, computer.instanceId]),
  );
  useEffect(() => {
    if (!window.nesvo) return;
    let current = true;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      for (const [hostId] of JSON.parse(available) as [
        string,
        string | null,
      ][]) {
        void desktopApi(hostId)
          .listProviderProfiles()
          .then(
            profiles => {
              if (current && request === generation)
                setCatalogs(previous => ({
                  ...previous,
                  [hostId]: { profiles },
                }));
            },
            error => {
              if (current && request === generation)
                setCatalogs(previous => ({
                  ...previous,
                  [hostId]: {
                    profiles: previous[hostId]?.profiles ?? [],
                    error: errorDetail(error),
                  },
                }));
            },
          );
      }
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      current = false;
      window.removeEventListener('focus', refresh);
    };
  }, [available]);
  const update = (hostId: string, profiles: ProviderProfile[]) =>
    setCatalogs(previous => ({ ...previous, [hostId]: { profiles } }));
  return { catalogs, update };
}
