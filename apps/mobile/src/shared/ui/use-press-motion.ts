import { useCallback, useEffect, useState } from 'react';

import { Animated, Easing, Platform } from 'react-native';

import { useMotionPreference } from '@shared/brand';

/** A short transform on press; the static pressed tint remains available without motion. */
export function usePressMotion() {
  const motionAllowed = useMotionPreference();
  const [scale] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (motionAllowed) return;
    scale.stopAnimation();
    scale.setValue(1);
  }, [motionAllowed, scale]);

  useEffect(() => () => scale.stopAnimation(), [scale]);

  const animateTo = useCallback(
    (toValue: number) => {
      if (!motionAllowed) return;
      scale.stopAnimation();
      Animated.timing(scale, {
        toValue,
        duration: 110,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      }).start();
    },
    [motionAllowed, scale],
  );

  return {
    scale,
    onPressIn: () => animateTo(0.98),
    onPressOut: () => animateTo(1),
  };
}
