import { atom, computed } from 'nanostores';

import type { ConnectionState, HostConfig } from '../contracts/connection-state';

export const IDLE_CONNECTION: ConnectionState = { status: 'idle', message: null, attempt: 0 };

export const $connectionState = atom<ConnectionState>(IDLE_CONNECTION);
export const $hostConfig = atom<HostConfig | null>(null);

export const $needsPairing = computed($hostConfig, config => config !== null && !config.hasPairing);
