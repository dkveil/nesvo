import { useEffect, useState, useSyncExternalStore } from 'react';

import { AccessibilityInfo, AppState, Platform } from 'react-native';

function subscribeForeground(onChange: () => void) {
  const subscription = AppState.addEventListener('change', onChange);
  return () => subscription.remove();
}

/** Animation stays still until the native accessibility preference is known. */
export function useMotionPreference() {
  const [reducedMotion, setReducedMotion] = useState(true);
  const foreground = useSyncExternalStore(
    subscribeForeground,
    () => AppState.currentState === 'active',
    () => false,
  );
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    let mounted = true;
    let preferenceChanged = false;
    const preference = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      preferenceChanged = true;
      setReducedMotion(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(value => {
        if (mounted && !preferenceChanged) {
          setReducedMotion(value);
        }
      })
      .catch(() => {
        // Keep the static mark when the accessibility setting cannot be read.
      });
    const blur =
      Platform.OS === 'android' ? AppState.addEventListener('blur', () => setFocused(false)) : null;
    const focus =
      Platform.OS === 'android' ? AppState.addEventListener('focus', () => setFocused(true)) : null;
    return () => {
      mounted = false;
      preference.remove();
      blur?.remove();
      focus?.remove();
    };
  }, []);

  return !reducedMotion && foreground && focused;
}
