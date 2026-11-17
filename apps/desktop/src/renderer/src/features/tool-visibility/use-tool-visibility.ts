import { useSyncExternalStore } from 'react';
import {
  readToolVisibility,
  saveToolVisibility,
  toolVisibilityKey,
  type ToolVisibility,
} from './tool-visibility-preference';

const listeners = new Set<() => void>();
let current: ToolVisibility | null = null;

const snapshot = () => (current ??= readToolVisibility());

const notify = () => {
  for (const listener of listeners) listener();
};

const onStorage = (event: StorageEvent) => {
  if (event.key !== null && event.key !== toolVisibilityKey) return;
  current = readToolVisibility();
  notify();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
};

export const setToolVisibility = (visibility: ToolVisibility) => {
  current = visibility;
  saveToolVisibility(visibility);
  notify();
};

export const useToolVisibility = () =>
  [
    useSyncExternalStore(subscribe, snapshot, snapshot),
    setToolVisibility,
  ] as const;
