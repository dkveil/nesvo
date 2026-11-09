const key = 'nesvo.sidebar-open.v1';

export function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(key) !== 'false';
  } catch {
    return true;
  }
}

export function saveSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(key, String(open));
  } catch {
    return;
  }
}
