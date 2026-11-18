const key = 'nesvo.onboarding.v1';

export function readOnboardingCompleted(): boolean {
  try {
    return localStorage.getItem(key) === 'completed';
  } catch {
    return false;
  }
}

export function saveOnboardingCompleted(): void {
  try {
    localStorage.setItem(key, 'completed');
  } catch {
    return;
  }
}
