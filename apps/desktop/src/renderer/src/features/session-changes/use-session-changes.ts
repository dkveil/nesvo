import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type {
  DesktopApi,
  SessionChangeScope,
  SessionChangeSet,
  SessionChanges,
} from '@nesvo/contracts';
import { errorDetail, type Session } from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';

export type SessionChangesApi = Pick<
  DesktopApi,
  'readSessionChanges' | 'readSessionChangePatch'
>;

export type SessionChangesState = {
  changes: SessionChanges | null;
  loading: boolean;
  error: string;
};

const IDLE: SessionChangesState = { changes: null, loading: false, error: '' };
const listeners = new Set<() => void>();
const inFlight = new Set<string>();
let states: Record<string, SessionChangesState> = {};

const update = (key: string, next: Partial<SessionChangesState>) => {
  states = { ...states, [key]: { ...(states[key] ?? IDLE), ...next } };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const load = (key: string, sessionId: string, api: SessionChangesApi) => {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  update(key, { loading: true });
  api.readSessionChanges({ sessionId }).then(
    changes => {
      inFlight.delete(key);
      update(key, { changes, loading: false, error: '' });
    },
    (failure: unknown) => {
      inFlight.delete(key);
      update(key, {
        loading: false,
        error: `Changes could not be read. ${errorDetail(failure)}`,
      });
    },
  );
};

const runToken = (session: Session) =>
  session.status === 'running' || session.status === 'stopping'
    ? 'running'
    : `${session.runId ?? ''}:${session.status}`;

export const useSessionChanges = (
  session: Session,
  api: SessionChangesApi | null,
) => {
  const key = entityKey(session);
  const state = useSyncExternalStore(subscribe, () => states[key] ?? IDLE);
  const token = runToken(session);
  const sessionId = session.id;
  useEffect(() => {
    if (!api || token === 'running') return;
    load(key, sessionId, api);
  }, [api, key, sessionId, token]);
  const refresh = useCallback(() => {
    if (api) load(key, sessionId, api);
  }, [api, key, sessionId]);
  return { ...state, refresh };
};

export const preferredScope = (
  changes: SessionChanges | null,
): SessionChangeScope =>
  changes?.uncommitted.status === 'available' &&
  changes.uncommitted.files.length === 0 &&
  changes.branch.status === 'available' &&
  changes.branch.files.length > 0
    ? 'branch'
    : 'uncommitted';

export const changeSetOf = (
  changes: SessionChanges | null,
  scope: SessionChangeScope,
): SessionChangeSet | null => (changes ? changes[scope] : null);
