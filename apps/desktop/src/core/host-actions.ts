import {
  $connectionState,
  $hostConfig,
  IDLE_CONNECTION,
} from '../modules/connection/core/connection-store';
import {
  connectToHost,
  forgetPairing,
  loadHostConfig,
  refreshSessions,
  saveHostPort,
  savePairing,
} from '../modules/connection/integration/host-commands';
import { $snapshot } from '../modules/sessions/core/sessions-store';
import { $screen } from './navigation-store';

export const startHostLink = async () => {
  const config = await loadHostConfig();
  $hostConfig.set(config);
  if (config.hasPairing) await connectToHost();
};

export const pairHost = async (pairing: string) => {
  $hostConfig.set(await savePairing(pairing));
  $screen.set('sessions');
  await connectToHost();
};

export const changeHostPort = async (port: number) => {
  $hostConfig.set(await saveHostPort(port));
  await connectToHost();
};

export const forgetHost = async () => {
  $hostConfig.set(await forgetPairing());
  $snapshot.set(null);
  $connectionState.set(IDLE_CONNECTION);
  $screen.set('sessions');
};

export const refreshHostSessions = () => refreshSessions();
