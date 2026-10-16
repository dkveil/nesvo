import type { SessionGroup } from './connection/types';

export function groupDescendants(groups: SessionGroup[], groupId: string): Set<string> {
  const ids = new Set([groupId]);
  const queue = [groupId];
  for (const parent of queue) {
    for (const group of groups) {
      if (group.parentId === parent && !ids.has(group.id)) {
        ids.add(group.id);
        queue.push(group.id);
      }
    }
  }
  return ids;
}

export function flattenGroups(groups: SessionGroup[]): (SessionGroup & { depth: number })[] {
  const result: (SessionGroup & { depth: number })[] = [];
  const seen = new Set<string>();
  function visit(parentId: string | null, depth: number) {
    for (const group of groups
      .filter((item) => item.parentId === parentId)
      .sort(
        (a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      )) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      result.push({ ...group, depth });
      visit(group.id, depth + 1);
    }
  }
  visit(null, 0);
  return result;
}

export function groupPath(groups: SessionGroup[], groupId: string | null | undefined): string {
  const names: string[] = [];
  const seen = new Set<string>();
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId);
    const group = groups.find((item) => item.id === groupId);
    if (!group) break;
    names.unshift(group.name);
    groupId = group.parentId;
  }
  return names.join(' / ') || 'Bez grupy';
}

export function validGroupName(name: string): boolean {
  const characters = Array.from(name.trim());
  return (
    characters.length > 0 &&
    characters.length <= 80 &&
    characters.every((character) => {
      const code = character.codePointAt(0)!;
      return code >= 32 && (code < 127 || code > 159);
    })
  );
}

export const demoGroups: SessionGroup[] = [
  { id: 'demo-workspace', name: 'Workspace', parentId: null, order: 0 },
  { id: 'demo-mobile', name: 'Aplikacja mobilna', parentId: 'demo-workspace', order: 0 },
];
