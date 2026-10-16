import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void) {
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  preference.addEventListener('change', onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    preference.removeEventListener('change', onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

function getSnapshot() {
  return (
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
    document.visibilityState === 'visible'
  );
}

/** Browser visibility and OS motion preferences mirror the native lifecycle gate. */
export function useMotionPreference() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
