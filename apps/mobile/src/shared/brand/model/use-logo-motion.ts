import { useEffect, useState } from 'react';

import { getLogoFrame, nextLogoFrameDelay } from './logo-motion';
import { useMotionPreference } from './use-motion-preference';

const STATIC_FRAME = getLogoFrame(0);

/** Sparse SVG keyframes update only this mark, never the surrounding workspace. */
export function useLogoMotion(active: boolean) {
  const motionAllowed = useMotionPreference();
  const running = active && motionAllowed;
  const [frame, setFrame] = useState(STATIC_FRAME);

  useEffect(() => {
    if (!running) return;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      const elapsed = performance.now() - started;
      setFrame(getLogoFrame(elapsed));
      timer = setTimeout(tick, nextLogoFrameDelay(elapsed));
    }
    tick();
    return () => clearTimeout(timer);
  }, [running]);

  return running ? frame : STATIC_FRAME;
}
