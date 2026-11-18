import { useEffect, useState } from 'react';
import type { GateRuleOverview, WorkspaceEvent } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

export const gateRulesChanged = (event: WorkspaceEvent) =>
  event.type === 'gate-rule-proposal-changed' ||
  event.type === 'gate-rule-generation-changed' ||
  (event.type === 'workflow-assistant-change' &&
    event.change.kind === 'gate-rule');

export function useGateRules(hostId: string, enabled: boolean, runId?: string) {
  const [overview, setOverview] = useState<GateRuleOverview | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let revision = 0;
    const load = () => {
      const request = ++revision;
      void window.nesvo
        .gateRules({ action: 'read', ...(runId ? { runId } : {}) }, hostId)
        .then(
          result => {
            if (!active || request !== revision) return;
            setOverview(result);
            setError('');
          },
          reason => {
            if (active && request === revision) setError(errorDetail(reason));
          },
        );
    };
    const release = window.nesvo.subscribe(event => {
      if (
        'hostId' in event &&
        event.hostId === hostId &&
        gateRulesChanged(event)
      )
        load();
    });
    load();
    return () => {
      active = false;
      release();
    };
  }, [enabled, hostId, refresh, runId]);
  return { overview, error, reload: () => setRefresh(version => version + 1) };
}
