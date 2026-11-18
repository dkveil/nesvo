import { useEffect, useState } from 'react';
import type { Computer, GateRuleProposal } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { gateRulesChanged } from '@/features/gate-rules/use-gate-rules';

type HostProposals = { proposals: GateRuleProposal[]; error: string };

export function useInboxGateRules(computers: Computer[]) {
  const hosts = computers
    .filter(
      computer =>
        computer.status === 'connected' &&
        computer.capabilities.includes('gate-rules'),
    )
    .map(computer => `${computer.id}:${computer.instanceId ?? ''}`)
    .sort()
    .join(',');
  const [byHost, setByHost] = useState<Record<string, HostProposals>>({});
  useEffect(() => {
    if (!hosts) return;
    let active = true;
    const hostIds = hosts.split(',').map(item => item.split(':')[0]!);
    const revisions = new Map<string, number>();
    const load = (hostId: string) => {
      const revision = (revisions.get(hostId) ?? 0) + 1;
      revisions.set(hostId, revision);
      void window.nesvo.gateRules({ action: 'read' }, hostId).then(
        overview => {
          if (active && revisions.get(hostId) === revision)
            setByHost(previous => ({
              ...previous,
              [hostId]: { proposals: overview.proposals, error: '' },
            }));
        },
        reason => {
          if (active && revisions.get(hostId) === revision)
            setByHost(previous => ({
              ...previous,
              [hostId]: {
                proposals: previous[hostId]?.proposals ?? [],
                error: errorDetail(reason),
              },
            }));
        },
      );
    };
    const release = window.nesvo.subscribe(event => {
      if (
        'hostId' in event &&
        hostIds.includes(event.hostId) &&
        gateRulesChanged(event)
      )
        load(event.hostId);
    });
    for (const hostId of hostIds) load(hostId);
    return () => {
      active = false;
      release();
    };
  }, [hosts]);
  const online = computers.filter(computer => computer.status === 'connected');
  return {
    rows: online.flatMap(({ id }) =>
      (byHost[id]?.proposals ?? []).map(proposal => ({ hostId: id, proposal })),
    ),
    errors: online.flatMap(({ id, name }) =>
      byHost[id]?.error ? [`${name}: ${byHost[id].error}`] : [],
    ),
  };
}
