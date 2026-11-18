import { useCallback, useEffect, useState } from 'react';
import type { DesktopApi, Provider } from '@nesvo/contracts';
import type { ProviderState } from '@/entities/session';
import { errorDetail } from '@/entities/session';

export function useProfileStatus(
  api: Pick<DesktopApi, 'codexStatus' | 'claudeStatus'> | undefined,
  hostId: string,
  provider: Provider,
  profileId: string | null | undefined,
  connected: boolean,
) {
  const key = JSON.stringify([hostId, provider, profileId]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    attempt: number;
    state: ProviderState;
  }>();
  useEffect(() => {
    if (!api || !profileId || !connected) return;
    let current = true;
    const read = provider === 'Codex' ? api.codexStatus : api.claudeStatus;
    void read(undefined, { profileId }).then(
      status => {
        if (current)
          setResult({
            key,
            attempt,
            state: { loading: false, status, error: '' },
          });
      },
      error => {
        if (current)
          setResult({
            key,
            attempt,
            state: { loading: false, status: null, error: errorDetail(error) },
          });
      },
    );
    return () => {
      current = false;
    };
  }, [api, attempt, connected, key, profileId, provider]);
  const refresh = useCallback(() => setAttempt(previous => previous + 1), []);
  const state: ProviderState =
    result?.key === key && result.attempt === attempt
      ? result.state
      : { loading: connected, status: null, error: '' };
  return { state, refresh };
}
