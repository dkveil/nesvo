import {
  SESSION_GROUP_MAX_DEPTH,
  compareGroupOrder,
  compareSessionOrder,
  type SessionGroup,
} from '@nesvo/contracts';
import type { Session } from '@/entities/session';

export type GroupNode = {
  group: SessionGroup;
  depth: number;
  children: GroupNode[];
  sessions: Session[];
  count: number;
};

export type HostTree = {
  pinned: Session[];
  groups: GroupNode[];
  ungrouped: Session[];
  archived: Session[];
};

const buildNodes = (
  parentId: string | null,
  depth: number,
  groups: SessionGroup[],
  members: Map<string, Session[]>,
): GroupNode[] =>
  groups
    .filter(group => group.parentId === parentId)
    .sort(compareGroupOrder)
    .map(group => {
      const children = buildNodes(group.id, depth + 1, groups, members);
      const sessions = (members.get(group.id) ?? []).sort(compareSessionOrder);
      return {
        group,
        depth,
        children,
        sessions,
        count:
          sessions.length +
          children.reduce((total, child) => total + child.count, 0),
      };
    });

export function buildHostTree(
  roots: Session[],
  groups: SessionGroup[],
): HostTree {
  const known = new Set(groups.map(group => group.id));
  const active = roots.filter(session => !session.archivedAt);
  const members = new Map<string, Session[]>();
  const ungrouped: Session[] = [];
  for (const session of active) {
    if (session.pinned) continue;
    if (session.groupId && known.has(session.groupId))
      members.set(session.groupId, [
        ...(members.get(session.groupId) ?? []),
        session,
      ]);
    else ungrouped.push(session);
  }
  return {
    pinned: active.filter(session => session.pinned).sort(compareSessionOrder),
    groups: buildNodes(null, 1, groups, members),
    ungrouped: ungrouped.sort(compareSessionOrder),
    archived: roots
      .filter(session => session.archivedAt)
      .sort((left, right) =>
        (right.archivedAt ?? '').localeCompare(left.archivedAt ?? ''),
      ),
  };
}

export function pruneEmpty(nodes: GroupNode[]): GroupNode[] {
  return nodes
    .filter(node => node.count > 0)
    .map(node => ({ ...node, children: pruneEmpty(node.children) }));
}

export function groupDepth(group: SessionGroup, groups: SessionGroup[]) {
  let depth = 1;
  let parentId = group.parentId;
  while (parentId) {
    const parent = groups.find(item => item.id === parentId);
    if (!parent) break;
    depth++;
    parentId = parent.parentId;
  }
  return depth;
}

function groupHeight(group: SessionGroup, groups: SessionGroup[]): number {
  return (
    1 +
    Math.max(
      0,
      ...groups
        .filter(item => item.parentId === group.id)
        .map(child => groupHeight(child, groups)),
    )
  );
}

export function isInside(
  candidate: SessionGroup,
  ancestor: SessionGroup,
  groups: SessionGroup[],
) {
  let current: SessionGroup | undefined = candidate;
  while (current) {
    if (current.id === ancestor.id) return true;
    const parentId: string | null = current.parentId;
    current = parentId ? groups.find(item => item.id === parentId) : undefined;
  }
  return false;
}

export function canReparent(
  group: SessionGroup,
  parent: SessionGroup | null,
  groups: SessionGroup[],
) {
  if (!parent) return true;
  return (
    !isInside(parent, group, groups) &&
    groupDepth(parent, groups) + groupHeight(group, groups) <=
      SESSION_GROUP_MAX_DEPTH
  );
}

export function canNestUnder(parent: SessionGroup, groups: SessionGroup[]) {
  return groupDepth(parent, groups) < SESSION_GROUP_MAX_DEPTH;
}

export function groupPath(group: SessionGroup, groups: SessionGroup[]) {
  const names = [group.name];
  let parentId = group.parentId;
  while (parentId) {
    const parent = groups.find(item => item.id === parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(' / ');
}

export function orderedGroups(groups: SessionGroup[]) {
  const visit = (parentId: string | null): SessionGroup[] =>
    groups
      .filter(group => group.parentId === parentId)
      .sort(compareGroupOrder)
      .flatMap(group => [group, ...visit(group.id)]);
  return visit(null);
}
