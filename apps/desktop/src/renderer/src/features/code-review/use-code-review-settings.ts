import { useCallback, useEffect, useState } from 'react';
import type { CodeReviewSettings, DesktopApi } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

type SettingsState = {
  settings: CodeReviewSettings | null;
  status: 'loading' | 'ready' | 'error';
  error: string;
};

export function useCodeReviewSettings(
  api: Pick<DesktopApi, 'readCodeReviewSettings'> | null,
  hostId: string,
  enabled: boolean,
) {
  const [state, setState] = useState<SettingsState>({
    settings: null,
    status: 'loading',
    error: '',
  });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled || !api) return;
    let active = true;
    api.readCodeReviewSettings().then(
      settings => {
        if (active) setState({ settings, status: 'ready', error: '' });
      },
      (failure: unknown) => {
        if (active)
          setState(previous => ({
            ...previous,
            status: 'error',
            error: errorDetail(failure),
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [api, hostId, enabled, version]);
  const replace = useCallback(
    (settings: CodeReviewSettings) =>
      setState({ settings, status: 'ready', error: '' }),
    [],
  );
  const reload = useCallback(() => setVersion(value => value + 1), []);
  return { ...state, replace, reload };
}
