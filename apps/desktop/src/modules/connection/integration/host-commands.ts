import { callHost } from '../../../libs/tauri-bridge/bridge';
import type { HostConfig } from '../contracts/connection-state';

export const loadHostConfig = () => callHost<HostConfig>('load_config');
export const savePairing = (pairing: string) => callHost<HostConfig>('save_pairing', { pairing });
export const selectLocalHost = () => callHost<HostConfig>('use_local_host');
export const forgetPairing = () => callHost<HostConfig>('forget_pairing');
export const saveHostPort = (port: number) => callHost<HostConfig>('save_port', { port });
export const saveHostBinary = (path: string | null) =>
  callHost<HostConfig>('save_host_binary', { path });
export const connectToHost = () => callHost<void>('connect');
export const disconnectFromHost = () => callHost<void>('disconnect');
export const stopLocalHost = () => callHost<void>('stop_local_host');
export const refreshSessions = () => callHost<void>('refresh');
