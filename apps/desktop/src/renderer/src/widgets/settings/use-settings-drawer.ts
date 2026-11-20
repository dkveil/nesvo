import { useCallback, useRef } from 'react';

export type Drawer = { close: () => void; dismiss: () => void };

export function useSettingsDrawer() {
  const activeDrawer = useRef<Drawer | null>(null);
  const registerDrawer = useCallback((drawer: Drawer) => {
    const previous = activeDrawer.current;
    activeDrawer.current = drawer;
    previous?.dismiss();
    return () => {
      if (activeDrawer.current === drawer) activeDrawer.current = null;
    };
  }, []);
  return { activeDrawer, registerDrawer };
}
