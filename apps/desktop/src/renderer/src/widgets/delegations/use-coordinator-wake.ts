import { useCallback, useEffect, useState } from 'react';
import type { CoordinatorWakeState, DesktopApi } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

type WakeApi = Pick<
  DesktopApi,
  'readCoordinatorWake' | 'setCoordinatorWake' | 'continueCoordinatorDelivery'
>;

export function useCoordinatorWake(
  api: WakeApi | undefined,
  hostId: string,
  sessionId: string | null,
) {
  const [loaded, setLoaded] = useState<{
    key: string;
    state: CoordinatorWakeState;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(
    null,
  );
  const key = `${hostId}/${sessionId ?? 'computer'}`;
  const refresh = useCallback(async () => {
    if (!api) return;
    const state = await api.readCoordinatorWake({ sessionId }, hostId);
    setLoaded({ key, state });
    return state;
  }, [api, hostId, key, sessionId]);
  useEffect(() => {
    if (!api) return;
    let current = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const state = await api.readCoordinatorWake({ sessionId }, hostId);
        if (current) setLoaded({ key, state });
      } catch (error) {
        if (current) setFailure({ key, text: errorDetail(error) });
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = sessionId
      ? window.setInterval(() => void read(), 1500)
      : null;
    return () => {
      current = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [api, hostId, key, sessionId]);
  const state = api && loaded?.key === key ? loaded.state : null;
  const save = async (enabled: boolean) => {
    if (!api || !state || pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await api.setCoordinatorWake(
        {
          sessionId,
          enabled,
          expectedRevision: state.revision,
          actionId: crypto.randomUUID(),
        },
        hostId,
      );
      setLoaded({ key, state: result });
    } catch (error) {
      setFailure({ key, text: errorDetail(error) });
      await refresh().catch(() => undefined);
    } finally {
      setPending(false);
    }
  };
  const resume = async (messageId: string) => {
    if (!api || !sessionId || !state?.batchId)
      throw new Error('Refresh the pending child updates.');
    await api.continueCoordinatorDelivery(
      { sessionId, batchId: state.batchId, messageId },
      hostId,
    );
    await refresh();
  };
  return {
    state,
    save,
    resume,
    pending,
    error: failure?.key === key ? failure.text : '',
  };
}
