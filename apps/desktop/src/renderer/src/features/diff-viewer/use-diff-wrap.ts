import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'nesvo.diff.wrap.v1';
const listeners = new Set<() => void>();

const readWrap = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

let current = readWrap();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const saveWrap = (wrap: boolean) => {
  try {
    localStorage.setItem(STORAGE_KEY, String(wrap));
  } catch {
    return;
  }
};

const setDiffWrap = (wrap: boolean) => {
  current = wrap;
  saveWrap(wrap);
  for (const listener of listeners) listener();
};

export const useDiffWrap = (): [boolean, (wrap: boolean) => void] => [
  useSyncExternalStore(subscribe, () => current),
  setDiffWrap,
];
