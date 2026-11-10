const key = 'nesvo.sidebar-width.v1';

export const SIDEBAR_DEFAULT_WIDTH_PX = 256;
export const SIDEBAR_MIN_WIDTH_PX = 208;
const MAIN_MIN_WIDTH_PX = 640;

export function sidebarMaxWidth(viewportWidth = window.innerWidth) {
  return Math.max(
    SIDEBAR_MIN_WIDTH_PX,
    Math.floor(viewportWidth) - MAIN_MIN_WIDTH_PX,
  );
}

export function clampSidebarWidth(width: number, viewportWidth?: number) {
  return Math.round(
    Math.min(
      sidebarMaxWidth(viewportWidth),
      Math.max(SIDEBAR_MIN_WIDTH_PX, width),
    ),
  );
}

export function readSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem(key));
    return stored ? stored : SIDEBAR_DEFAULT_WIDTH_PX;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH_PX;
  }
}

export function saveSidebarWidth(width: number): void {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    return;
  }
}
