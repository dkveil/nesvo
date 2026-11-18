const key = 'nesvo.desktop-notifications.v1';

export function readNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(key) !== 'false';
  } catch {
    return true;
  }
}

export function saveNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(key, String(enabled));
  } catch {
    return;
  }
}
