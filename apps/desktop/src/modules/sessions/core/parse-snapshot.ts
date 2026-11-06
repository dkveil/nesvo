import type { SessionGroup, SessionsSnapshot } from '../contracts/session-snapshot';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isSession = (value: unknown) =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.cwd === 'string' &&
  typeof value.running === 'boolean';

const isGroup = (value: unknown): value is SessionGroup =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.name === 'string' &&
  typeof value.order === 'number' &&
  (value.parentId === null || typeof value.parentId === 'string');

export const parseSnapshot = (value: unknown): SessionsSnapshot | null => {
  if (!isRecord(value) || value.type !== 'sessions') return null;
  const { sessions, groups, revision } = value;
  if (!Array.isArray(sessions) || !Array.isArray(groups) || typeof revision !== 'number') {
    return null;
  }
  if (!sessions.every(isSession) || !groups.every(isGroup)) return null;
  return { sessions, groups, revision } as SessionsSnapshot;
};
