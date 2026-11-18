import { useCallback, useEffect, useRef, useState } from 'react';
import type { Computer, DesktopApi } from '@nesvo/contracts';
import {
  errorDetail,
  providers,
  type Provider,
  type ProviderStates,
} from '@/entities/session';

const unchecked = { status: null, loading: false, error: '' };

export function useOnboardingComputers(api: DesktopApi) {
  const [computers, setComputers] = useState<Computer[]>([]);
  const [error, setError] = useState('');
  const [statuses, setStatuses] = useState<ProviderStates>({
    'Claude Code': unchecked,
    Codex: unchecked,
  });
  const requests = useRef(0);

  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = api.subscribe(event => {
      if (event.type !== 'computers-changed') return;
      changed = true;
      setComputers(event.computers);
      setError('');
    });
    void api.listComputers().then(
      list => {
        if (active && !changed) setComputers(list);
      },
      failure => {
        if (active && !changed) setError(errorDetail(failure));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  const checkProviders = useCallback(() => {
    const request = ++requests.current;
    setStatuses(previous => ({
      'Claude Code': { ...previous['Claude Code'], loading: true, error: '' },
      Codex: { ...previous.Codex, loading: true, error: '' },
    }));
    for (const provider of providers) {
      const update = (state: ProviderStates[Provider]) => {
        if (requests.current === request)
          setStatuses(previous => ({ ...previous, [provider]: state }));
      };
      const probe =
        provider === 'Claude Code'
          ? api.claudeStatus('local')
          : api.codexStatus('local');
      void probe.then(
        status => update({ status, loading: false, error: '' }),
        failure =>
          update({ status: null, loading: false, error: errorDetail(failure) }),
      );
    }
  }, [api]);

  const local = computers.find(computer => computer.id === 'local');
  const ready = local?.status === 'connected';
  const instance = local?.instanceId;
  useEffect(() => {
    let active = true;
    if (ready)
      queueMicrotask(() => {
        if (active) checkProviders();
      });
    return () => {
      active = false;
    };
  }, [ready, instance, checkProviders]);

  return { computers, local, error, statuses, checkProviders };
}
