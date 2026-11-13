export type WorkspaceLocation = {
  selectedId: string;
  inbox: boolean;
  automation: string;
  diff: { reviewId: string; path?: string } | null;
};

const key = 'nesvo.workspace-location.v1';
const identifier = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const entityIdentifier = (value: string) =>
  identifier.test(value) ||
  (value.split('/').length === 2 &&
    value.split('/').every(part => identifier.test(part)));
const initial: WorkspaceLocation = {
  selectedId: '',
  inbox: false,
  automation: '',
  diff: null,
};
const automationTarget = (value: unknown) =>
  typeof value === 'string' &&
  (value === '' || value === 'list' || entityIdentifier(value))
    ? value
    : '';

export function readWorkspaceLocation(): WorkspaceLocation {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 8192) return initial;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return initial;
    const saved = value as Record<string, unknown>;
    if (
      typeof saved.selectedId !== 'string' ||
      (saved.selectedId !== '' && !entityIdentifier(saved.selectedId)) ||
      typeof saved.inbox !== 'boolean'
    )
      return initial;
    let diff: WorkspaceLocation['diff'] = null;
    if (saved.diff && typeof saved.diff === 'object') {
      const target = saved.diff as Record<string, unknown>;
      if (
        typeof target.reviewId === 'string' &&
        identifier.test(target.reviewId) &&
        (target.path === undefined ||
          (typeof target.path === 'string' && target.path.length <= 4096))
      )
        diff = {
          reviewId: target.reviewId,
          ...(typeof target.path === 'string' ? { path: target.path } : {}),
        };
    }
    return {
      selectedId: saved.selectedId,
      inbox: saved.inbox,
      automation: saved.inbox ? '' : automationTarget(saved.automation),
      diff,
    };
  } catch {
    return initial;
  }
}

export function saveWorkspaceLocation(location: WorkspaceLocation): void {
  try {
    localStorage.setItem(key, JSON.stringify(location));
  } catch {
    return;
  }
}
