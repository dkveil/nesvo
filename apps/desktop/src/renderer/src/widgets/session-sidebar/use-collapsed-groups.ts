import { useEffect, useState } from 'react';

const STORAGE_KEY = 'nesvo.sidebar.collapsed-groups';
const MAX_REMEMBERED_GROUPS = 500;

function readCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string')
          .slice(-MAX_REMEMBERED_GROUPS)
      : [];
  } catch {
    return [];
  }
}

function writeCollapsed(keys: string[]) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(keys.slice(-MAX_REMEMBERED_GROUPS)),
    );
  } catch {
    return;
  }
}

export const collapseKey = (hostId: string, groupId: string) =>
  `${hostId}/${groupId}`;

export function useCollapsedGroups() {
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  useEffect(() => writeCollapsed(collapsed), [collapsed]);
  const isCollapsed = (key: string) => collapsed.includes(key);
  const toggle = (key: string, value = !collapsed.includes(key)) =>
    setCollapsed(previous =>
      value
        ? [...previous.filter(item => item !== key), key]
        : previous.filter(item => item !== key),
    );
  return { isCollapsed, toggle };
}
