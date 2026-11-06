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
  saveHostBinary,
  saveHostPort,
  savePairing,
  selectLocalHost,
  stopLocalHost,
} from '../modules/connection/integration/host-commands';
import { $snapshot } from '../modules/sessions/core/sessions-store';

export const startHostLink = async () => {
  $hostConfig.set(await loadHostConfig());
  await connectToHost();
};

const reconnect = async () => {
  $snapshot.set(null);
  await connectToHost();
};

export const pairRemoteHost = async (pairing: string) => {
  $hostConfig.set(await savePairing(pairing));
  await reconnect();
};

export const switchToLocalHost = async () => {
  $hostConfig.set(await selectLocalHost());
  await reconnect();
};

export const forgetRemoteHost = async () => {
  $hostConfig.set(await forgetPairing());
  await reconnect();
};

export const changeHostPort = async (port: number) => {
  $hostConfig.set(await saveHostPort(port));
  await reconnect();
};

export const changeHostBinary = async (path: string | null) => {
  $hostConfig.set(await saveHostBinary(path));
  await reconnect();
};

export const shutDownLocalHost = async () => {
  await stopLocalHost();
  $snapshot.set(null);
  $connectionState.set(IDLE_CONNECTION);
};

export const refreshHostSessions = () => refreshSessions();
