import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Provider } from '@nesvo/contracts';

export const managerRowLimit = 500;
export const sourceKey = (...parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export type SourceGroup = {
  kind: 'group';
  key: string;
  parent: string | null;
  title: string;
  profile: string | null;
  archivedAt: string | null;
  directory: string | null;
  order: number;
};

export type SourceSession = Omit<SourceGroup, 'kind'> & {
  kind: 'session';
  provider: Provider | null;
  nativeId: string | null;
  hasWorktree: boolean;
  branch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  blocked: string | null;
};

export type ManagerSource = {
  groups: SourceGroup[];
  contextGroups?: SourceGroup[];
  sessions: SourceSession[];
  groupCount: number;
  sessionCount: number;
  profileCount: number;
  partial?: boolean;
};

export function sourceText(value: unknown, limit = 4096) {
  return typeof value === 'string' &&
    value.length <= limit &&
    !value.includes('\0') &&
    value.trim()
    ? value
    : null;
}

export function sourceTitle(value: unknown, fallback: string, limit: number) {
  return typeof value === 'string'
    ? value.trim().slice(0, limit).trimEnd() || fallback
    : fallback;
}

export function sourceDate(value: unknown) {
  if (typeof value !== 'string' && (typeof value !== 'number' || value <= 0))
    return null;
  const date = new Date(
    typeof value === 'number' && value < 100_000_000_000 ? value * 1000 : value,
  );
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1970
    ? date.toISOString()
    : null;
}

export function explicitSourceRoot(value: string) {
  return isAbsolute(value) && !value.includes('\0') && !/^[\\/]{2}/.test(value);
}
