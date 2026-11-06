import { subscribeHost } from '../libs/tauri-bridge/bridge';
import { $connectionState } from '../modules/connection/core/connection-store';
import { parseConnectionState } from '../modules/connection/core/parse-connection-state';
import { parseSnapshot } from '../modules/sessions/core/parse-snapshot';
import { $snapshot } from '../modules/sessions/core/sessions-store';

export const HOST_STATE_EVENT = 'host://state';
export const HOST_SESSIONS_EVENT = 'host://sessions';

export const bindHostEvents = async () => {
  const unlisten = await Promise.all([
    subscribeHost<unknown>(HOST_STATE_EVENT, payload => {
      const state = parseConnectionState(payload);
      if (state) $connectionState.set(state);
    }),
    subscribeHost<unknown>(HOST_SESSIONS_EVENT, payload => {
      const snapshot = parseSnapshot(payload);
      if (snapshot) $snapshot.set(snapshot);
    }),
  ]);
  return () => unlisten.forEach(stop => stop());
};
