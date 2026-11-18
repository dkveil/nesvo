import { useEffect, useState } from 'react';
import type { DesktopApi, McpServerList, SkillCatalog } from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  providerUsable,
  type Provider,
  type ProviderStates,
} from '@/entities/session';

export type ProviderSetupReport = {
  provider: Provider;
  servers: McpServerList | null;
  skills: SkillCatalog | null;
  error: string;
};

type Api = Pick<DesktopApi, 'listMcpServers' | 'discoverSkills'>;

export function useProviderSetup(
  api: Api,
  hostId: string,
  directory: string,
  statuses: ProviderStates,
  enabled: boolean,
): ProviderSetupReport[] | null {
  const ready = providers.filter(provider =>
    providerUsable(statuses[provider]),
  );
  const readyKey = ready.join('|');
  const [reports, setReports] = useState<{
    key: string;
    value: ProviderSetupReport[];
  } | null>(null);
  const key = [hostId, directory, readyKey].join('\n');
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const selected = readyKey ? (readyKey.split('|') as Provider[]) : [];
    void Promise.all(
      selected.map(async provider => {
        const [servers, skills] = await Promise.allSettled([
          api.listMcpServers({ provider, directory }, hostId),
          api.discoverSkills({ provider, directory }, hostId),
        ]);
        const failure = [servers, skills].find(
          result => result.status === 'rejected',
        );
        return {
          provider,
          servers: servers.status === 'fulfilled' ? servers.value : null,
          skills: skills.status === 'fulfilled' ? skills.value : null,
          error: failure ? errorDetail(failure.reason) : '',
        };
      }),
    ).then(value => {
      if (!cancelled) setReports({ key, value });
    });
    return () => {
      cancelled = true;
    };
  }, [api, hostId, directory, readyKey, enabled, key]);
  return reports?.key === key ? reports.value : null;
}
