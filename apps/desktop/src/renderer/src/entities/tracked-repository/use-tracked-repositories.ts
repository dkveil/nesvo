import { useEffect, useSyncExternalStore } from 'react';
import type { DesktopApi, TrackedRepository } from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';

export type TrackedRepositoriesState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  repositories: TrackedRepository[];
  error: string;
};

const IDLE: TrackedRepositoriesState = {
  status: 'idle',
  repositories: [],
  error: '',
};

const states = new Map<string, TrackedRepositoriesState>();
const listeners = new Set<() => void>();
const pending = new Set<string>();

const publish = (hostId: string, state: TrackedRepositoriesState) => {
  states.set(hostId, state);
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function setTrackedRepositories(
  hostId: string,
  repositories: TrackedRepository[],
) {
  publish(hostId, { status: 'ready', repositories, error: '' });
}

const load = (
  api: Pick<DesktopApi, 'listTrackedRepositories'>,
  hostId: string,
) => {
  if (pending.has(hostId)) return;
  pending.add(hostId);
  const previous = states.get(hostId) ?? IDLE;
  publish(hostId, { ...previous, status: 'loading', error: '' });
  api.listTrackedRepositories().then(
    repositories => {
      pending.delete(hostId);
      setTrackedRepositories(hostId, repositories);
    },
    (failure: unknown) => {
      pending.delete(hostId);
      publish(hostId, {
        ...(states.get(hostId) ?? IDLE),
        status: 'error',
        error: errorDetail(failure),
      });
    },
  );
};

export function useTrackedRepositories(
  api: Pick<DesktopApi, 'listTrackedRepositories'> | null,
  hostId: string,
  enabled: boolean,
): TrackedRepositoriesState {
  const state = useSyncExternalStore(
    subscribe,
    () => states.get(hostId) ?? IDLE,
  );
  useEffect(() => {
    if (enabled && api) load(api, hostId);
  }, [api, hostId, enabled]);
  return enabled && api ? state : IDLE;
}
