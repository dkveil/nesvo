import { useEffect, useState } from 'react';
import type { Computer } from '@nesvo/contracts';

export function useSetupDrift(
  computer: Computer | undefined,
  enabled: boolean,
) {
  const hostId = computer?.id;
  const instanceId = computer?.instanceId;
  const online = computer?.status === 'connected';
  const supported = computer?.capabilities.includes('setup-detection-v1');
  const [drift, setDrift] = useState<{
    instanceId: string;
    revision: string;
    count: number;
  }>();
  const [viewed, setViewed] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!enabled || !online || !supported || !hostId || !instanceId) return;
    let active = true;
    const check = async () => {
      const result = await window.nesvo
        .setupDetection({ action: 'scan', trigger: 'startup' }, hostId)
        .catch(() => undefined);
      if (!active || !result?.ok || result.scan.instanceId !== instanceId)
        return;
      const changed = new Set(result.scan.changes);
      const revision = result.scan.findings
        .filter(finding => changed.has(finding.id))
        .map(finding => finding.revision)
        .sort()
        .join(':');
      setDrift(previous =>
        previous?.instanceId === instanceId && previous.revision === revision
          ? previous
          : { instanceId, revision, count: changed.size },
      );
    };
    void check();
    const timer = window.setInterval(() => void check(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, online, supported, hostId, instanceId]);

  const count =
    online &&
    drift?.instanceId === instanceId &&
    drift &&
    viewed[drift.instanceId] !== drift.revision
      ? drift.count
      : 0;
  return {
    count,
    markViewed: () => {
      if (drift && count)
        setViewed(previous => ({
          ...previous,
          [drift.instanceId]: drift.revision,
        }));
    },
  };
}
