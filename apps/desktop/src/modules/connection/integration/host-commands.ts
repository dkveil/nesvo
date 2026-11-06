import { callHost } from '../../../libs/tauri-bridge/bridge';
import type { HostConfig } from '../contracts/connection-state';

export const loadHostConfig = () => callHost<HostConfig>('load_config');
export const savePairing = (pairing: string) => callHost<HostConfig>('save_pairing', { pairing });
export const forgetPairing = () => callHost<HostConfig>('forget_pairing');
export const saveHostPort = (port: number) => callHost<HostConfig>('save_port', { port });
export const connectToHost = () => callHost<void>('connect');
export const disconnectFromHost = () => callHost<void>('disconnect');
export const refreshSessions = () => callHost<void>('refresh');
