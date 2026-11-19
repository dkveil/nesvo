import { useEffect, useRef, useState } from 'react';
import type {
  Computer,
  SetupDetectionInput,
  SetupChoice,
  SetupDiagnosticsBatch,
  SetupScan,
  SetupScanRequest,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

export function useSetupDetection(
  computer: Computer | undefined,
  { trigger, directory }: SetupScanRequest,
  enabled = true,
) {
  const hostId = computer?.id;
  const instanceId = computer?.instanceId;
  const supported = Boolean(
    computer?.capabilities.includes('setup-detection-v1'),
  );
  const online = computer?.status === 'connected';
  const [reported, setReported] = useState<{
    scope: string;
    scan: SetupScan;
    diagnostics?: SetupDiagnosticsBatch;
  }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef({ value: 0 });
  const scope = [hostId, instanceId, directory].join(':');

  useEffect(() => {
    if (
      !enabled ||
      !hostId ||
      !online ||
      !supported ||
      (trigger === 'first-open' && !directory)
    )
      return;
    const sequence = requestId.current;
    const id = ++sequence.value;
    const timer = window.setTimeout(
      () => {
        setBusy(true);
        setError('');
        void window.nesvo
          .setupDetection({ action: 'scan', trigger, directory }, hostId)
          .then(
            result => {
              if (id !== sequence.value) return;
              if (!result.ok) return setError(result.message);
              if (!instanceId || result.scan.instanceId === instanceId)
                setReported({ scope, scan: result.scan });
            },
            issue => {
              if (id === sequence.value) setError(errorDetail(issue));
            },
          )
          .finally(() => {
            if (id === sequence.value) setBusy(false);
          });
      },
      trigger === 'first-open' ? 280 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      sequence.value++;
    };
  }, [
    hostId,
    instanceId,
    online,
    supported,
    directory,
    trigger,
    scope,
    enabled,
  ]);

  const send = async (input: SetupDetectionInput) => {
    if (!hostId || !online || !supported || busy) return;
    const sequence = requestId.current;
    const id = ++sequence.value;
    setBusy(true);
    setError('');
    try {
      const result = await window.nesvo.setupDetection(input, hostId);
      if (id !== sequence.value) return;
      if (!result.ok) throw new Error(result.message);
      if (!instanceId || result.scan.instanceId === instanceId)
        setReported({
          scope,
          scan: result.scan,
          diagnostics: result.diagnostics,
        });
      return result.scan;
    } catch (issue) {
      if (id === sequence.value) setError(errorDetail(issue));
    } finally {
      if (id === sequence.value) setBusy(false);
    }
  };
  const scan =
    reported?.scope === scope &&
    (online || reported.scan.instanceId === instanceId)
      ? reported.scan
      : undefined;
  return {
    scan,
    diagnostics:
      reported?.scope === scope && online ? reported.diagnostics : undefined,
    busy,
    error,
    supported,
    online,
    refresh: () => send({ action: 'scan', trigger: 'manual', directory }),
    previewDiagnostics: () =>
      instanceId && send({ action: 'diagnostic-preview', instanceId }),
    verifyDiagnostics: (digest: string) =>
      instanceId && send({ action: 'verify-diagnostics', instanceId, digest }),
    applyChoices: (choices: SetupChoice[]) =>
      scan &&
      send({
        action: 'apply-choices',
        instanceId: scan.instanceId,
        revision: scan.revision,
        choices,
      }),
    acknowledge: () =>
      scan &&
      send({
        action: 'acknowledge',
        instanceId: scan.instanceId,
        revision: scan.revision,
        completed: false,
      }),
  };
}
