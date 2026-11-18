import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'nesvo.running-apps.v1';
const listeners = new Set<() => void>();

const readEnabled = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

let current = readEnabled();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const setRunningAppsEnabled = (enabled: boolean) => {
  current = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    return;
  } finally {
    for (const listener of listeners) listener();
  }
};

export const useRunningAppsEnabled = (): [
  boolean,
  (enabled: boolean) => void,
] => [useSyncExternalStore(subscribe, () => current), setRunningAppsEnabled];
