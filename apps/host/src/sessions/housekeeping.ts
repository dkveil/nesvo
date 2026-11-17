import {
  SESSION_GROUP_LIMIT,
  SESSION_GROUP_MAX_DEPTH,
  compareGroupOrder,
  compareSessionOrder,
  isGroupableSession,
  type CreateSessionGroupInput,
  type DeleteSessionGroupInput,
  type DesktopEvent,
  type MoveSessionGroupInput,
  type MoveSessionInput,
  type RenameSessionInput,
  type Session,
  type SessionGroup,
  type SessionGroupList,
  type SetSessionArchivedInput,
  type SetSessionPinnedInput,
  type UpdateSessionGroupInput,
} from '@nesvo/contracts';
import type { SessionGroupStore } from './group-store';
import { SessionError, type SessionService } from './service';

const invalid = (message: string) =>
  new SessionError('invalid-request', message);

const DEPTH_MESSAGE = `Groups can be nested up to ${SESSION_GROUP_MAX_DEPTH} levels.`;

const insertAt = <T>(items: T[], item: T, position: number): T[] => [
  ...items.slice(0, position),
  item,
  ...items.slice(position),
];

const depthOf = (group: SessionGroup, groups: SessionGroup[]): number => {
  let depth = 1;
  let parentId = group.parentId;
  while (parentId) {
    const parent = groups.find(item => item.id === parentId);
    if (!parent) break;
    depth++;
    parentId = parent.parentId;
  }
  return depth;
};

const heightOf = (group: SessionGroup, groups: SessionGroup[]): number =>
  1 +
  Math.max(
    0,
    ...groups
      .filter(item => item.parentId === group.id)
      .map(child => heightOf(child, groups)),
  );

const isWithin = (
  candidate: SessionGroup,
  ancestor: SessionGroup,
  groups: SessionGroup[],
): boolean => {
  let current: SessionGroup | undefined = candidate;
  while (current) {
    if (current.id === ancestor.id) return true;
    const parentId: string | null = current.parentId;
    current = parentId ? groups.find(item => item.id === parentId) : undefined;
  }
  return false;
};

const renumber = <T extends { order: number }>(
  items: T[],
  update: (item: T, order: number) => void,
): T[] =>
  items.filter((item, index) => {
    if (item.order === index + 1) return false;
    update(item, index + 1);
    return true;
  });

export class SessionHousekeeping {
  constructor(
    private readonly sessions: SessionService,
    private readonly groups: SessionGroupStore,
    private readonly emit: (event: DesktopEvent) => void,
  ) {}

  list(): SessionGroupList {
    return this.groups.list();
  }

  createGroup(input: CreateSessionGroupInput): SessionGroupList {
    const { groups } = this.groups.list();
    const existing = groups.find(group => group.id === input.groupId);
    if (existing) {
      if (existing.name === input.name && existing.parentId === input.parentId)
        return this.groups.list();
      throw invalid('This group ID is already in use.');
    }
    if (groups.length >= SESSION_GROUP_LIMIT)
      throw invalid(
        `A computer can hold up to ${SESSION_GROUP_LIMIT} session groups.`,
      );
    if (input.parentId) {
      const parent = this.destination(input.parentId, groups);
      if (depthOf(parent, groups) + 1 > SESSION_GROUP_MAX_DEPTH)
        throw invalid(DEPTH_MESSAGE);
    }
    const now = new Date().toISOString();
    const order =
      Math.max(
        0,
        ...groups
          .filter(group => group.parentId === input.parentId)
          .map(group => group.order),
      ) + 1;
    return this.commit([
      {
        id: input.groupId,
        parentId: input.parentId,
        name: input.name,
        order,
        defaults: input.defaults,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  }

  updateGroup(input: UpdateSessionGroupInput): SessionGroupList {
    const group = this.group(input.groupId, this.groups.list().groups);
    return this.commit([
      {
        ...group,
        name: input.name ?? group.name,
        defaults: input.defaults ?? group.defaults,
        updatedAt: new Date().toISOString(),
      },
    ]);
  }

  moveGroup(input: MoveSessionGroupInput): SessionGroupList {
    const { groups } = this.groups.list();
    const group = this.group(input.groupId, groups);
    if (input.parentId) {
      const parent = this.destination(input.parentId, groups);
      if (isWithin(parent, group, groups))
        throw invalid(
          'A group cannot move into itself or one of its subgroups.',
        );
      if (
        depthOf(parent, groups) + heightOf(group, groups) >
        SESSION_GROUP_MAX_DEPTH
      )
        throw invalid(DEPTH_MESSAGE);
    }
    const now = new Date().toISOString();
    const moved = { ...group, parentId: input.parentId, order: 0 };
    const siblings = groups
      .filter(item => item.parentId === input.parentId && item.id !== group.id)
      .map(item => ({ ...item }))
      .sort(compareGroupOrder);
    const ordered = insertAt(
      siblings,
      moved,
      Math.min(input.position, siblings.length),
    );
    const changed = renumber(ordered, (item, order) => {
      item.order = order;
      item.updatedAt = now;
    });
    return this.commit(changed);
  }

  deleteGroup(input: DeleteSessionGroupInput): SessionGroupList {
    const { groups } = this.groups.list();
    const group = this.group(input.groupId, groups);
    const now = new Date().toISOString();
    const siblings = groups
      .filter(item => item.parentId === group.parentId)
      .sort(compareGroupOrder);
    const children = groups
      .filter(item => item.parentId === group.id)
      .sort(compareGroupOrder)
      .map(item => ({ ...item, parentId: group.parentId, updatedAt: now }));
    const index = siblings.findIndex(item => item.id === group.id);
    const ordered = [
      ...siblings.slice(0, index).map(item => ({ ...item })),
      ...children,
      ...siblings.slice(index + 1).map(item => ({ ...item })),
    ];
    const changed = new Map(children.map(item => [item.id, item]));
    for (const item of renumber(ordered, (entry, order) => {
      entry.order = order;
      entry.updatedAt = now;
    }))
      changed.set(item.id, item);
    const members = this.sessions
      .list()
      .filter(session => session.groupId === group.id)
      .map(session => session.id);
    return this.commit([...changed.values()], [group.id], members, targets => {
      for (const session of targets) session.groupId = group.parentId;
    });
  }

  moveSession(input: MoveSessionInput): Session {
    const all = this.sessions.list();
    const session = this.session(input.sessionId, all);
    if (!isGroupableSession(session))
      throw invalid(
        'Subsessions and automation runs stay with their parent and cannot be moved on their own.',
      );
    if (input.groupId)
      this.destination(input.groupId, this.groups.list().groups);
    const siblings = all
      .filter(
        item =>
          item.id !== session.id &&
          item.groupId === input.groupId &&
          isGroupableSession(item) &&
          !item.archivedAt &&
          !item.pinned,
      )
      .sort(compareSessionOrder);
    const ordered = insertAt(
      siblings.map(item => ({ id: item.id, order: item.order })),
      { id: session.id, order: Number.NaN },
      Math.min(input.position, siblings.length),
    );
    const orders = new Map<string, number>();
    renumber(ordered, (item, order) => orders.set(item.id, order));
    const ids = [session.id, ...orders.keys()];
    const updated = this.sessions.amend(ids, targets => {
      for (const target of targets) {
        if (target.id === session.id) target.groupId = input.groupId;
        target.order = orders.get(target.id) ?? target.order;
      }
    });
    return updated.find(item => item.id === session.id)!;
  }

  renameSession(input: RenameSessionInput): Session {
    return this.amendOne(input.sessionId, session => {
      session.title = input.title;
    });
  }

  setPinned(input: SetSessionPinnedInput): Session {
    this.groupable(input.sessionId);
    return this.amendOne(input.sessionId, session => {
      session.pinned = input.pinned;
    });
  }

  setArchived(input: SetSessionArchivedInput): Session {
    const all = this.sessions.list();
    const session = this.groupable(input.sessionId, all);
    if (
      input.archived &&
      [session, ...this.descendants(session, all)].some(item =>
        this.sessions.isRunning(item.id),
      )
    )
      throw new SessionError(
        'busy',
        'Stop the session and its subsessions before archiving it.',
      );
    return this.amendOne(input.sessionId, target => {
      target.archivedAt = input.archived
        ? (target.archivedAt ?? new Date().toISOString())
        : null;
    });
  }

  private commit(
    changed: SessionGroup[],
    removed: string[] = [],
    sessionIds: string[] = [],
    change: (sessions: Session[]) => void = () => {},
  ): SessionGroupList {
    this.sessions.amend(sessionIds, change, () =>
      this.groups.write(changed, removed),
    );
    const list = this.groups.list();
    this.emit({ type: 'session-groups-changed', list });
    return list;
  }

  private amendOne(
    sessionId: string,
    change: (session: Session) => void,
  ): Session {
    const [session] = this.sessions.amend([sessionId], ([target]) => {
      if (target) change(target);
    });
    return session!;
  }

  private descendants(root: Session, all: Session[]): Session[] {
    return all.filter(
      item =>
        item.id !== root.id &&
        (item.parentId === root.id ||
          (!!root.workflowRunId &&
            !!item.workflowStepId &&
            item.workflowRunId === root.workflowRunId)),
    );
  }

  private session(sessionId: string, all: Session[]): Session {
    const session = all.find(item => item.id === sessionId);
    if (!session) throw new SessionError('not-found', 'Session not found.');
    return session;
  }

  private groupable(sessionId: string, all = this.sessions.list()): Session {
    const session = this.session(sessionId, all);
    if (!isGroupableSession(session))
      throw invalid(
        'Subsessions and automation runs follow their parent and cannot change on their own.',
      );
    return session;
  }

  private group(groupId: string, groups: SessionGroup[]): SessionGroup {
    const group = groups.find(item => item.id === groupId);
    if (!group)
      throw new SessionError('not-found', 'The session group was not found.');
    return group;
  }

  private destination(groupId: string, groups: SessionGroup[]): SessionGroup {
    const group = groups.find(item => item.id === groupId);
    if (!group)
      throw invalid(
        'The destination group no longer exists. Refresh the sidebar and try again.',
      );
    return group;
  }
}
