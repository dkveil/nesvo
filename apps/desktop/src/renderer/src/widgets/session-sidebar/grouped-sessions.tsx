import { useState, type MouseEvent, type ReactNode } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FolderInput,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SlidersHorizontal,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { SessionGroup } from '@nesvo/contracts';
import { cn } from '@/shared/lib/cn';
import type { Session } from '@/entities/session';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { toDropIndicator } from './drop-indicator';
import type { ProviderProfile } from '@nesvo/contracts';
import { GroupDefaultsDialog } from './group-defaults-dialog';
import type {
  DragItem,
  DropPlacement,
  RowDecoration,
  SidebarHousekeeping,
} from './housekeeping';
import { InlineNameInput } from './inline-name-input';
import { MoveToGroupDialog } from './move-to-group-dialog';
import { RowActionsMenu, type RowAction } from './row-actions-menu';
import {
  buildHostTree,
  canNestUnder,
  canReparent,
  pruneEmpty,
  type GroupNode,
} from './session-tree';
import { collapseKey } from './use-collapsed-groups';
import { useSidebarDrag } from './use-sidebar-drag';

type MoveTarget =
  | { kind: 'session'; session: Session }
  | { kind: 'group'; group: SessionGroup };

type Props = {
  hostId: string;
  profiles: ProviderProfile[];
  roots: Session[];
  allRoots: Session[];
  housekeeping: SidebarHousekeeping;
  searching: boolean;
  renaming: string | null;
  onRenamingChange: (key: string | null) => void;
  archivedOpen: boolean;
  onArchivedOpenChange: (open: boolean) => void;
  isCollapsed: (key: string) => boolean;
  onToggleCollapsed: (key: string, value?: boolean) => void;
  renderRoot: (session: Session, decoration: RowDecoration) => ReactNode[];
  automations?: ReactNode;
  threadActions?: (session: Session) => RowAction[];
  deleteAction?: (session: Session) => RowAction | null;
};

export function GroupedSessions({
  hostId,
  profiles,
  roots,
  allRoots,
  housekeeping,
  searching,
  renaming,
  onRenamingChange,
  archivedOpen,
  onArchivedOpenChange,
  isCollapsed,
  onToggleCollapsed,
  renderRoot,
  automations,
  threadActions,
  deleteAction,
}: Props) {
  const [menu, setMenu] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [defaultsGroup, setDefaultsGroup] = useState<SessionGroup | null>(null);
  const [deleting, setDeleting] = useState<SessionGroup | null>(null);
  const groups = housekeeping.groups(hostId);
  const drag = useSidebarDrag(!searching);
  const full = buildHostTree(allRoots, groups);
  const shown = buildHostTree(roots, groups);
  const visibleGroups = searching ? pruneEmpty(shown.groups) : shown.groups;
  const groupById = (id: string | null) =>
    id ? groups.find(group => group.id === id) : undefined;
  const findNode = (nodes: GroupNode[], id: string): GroupNode | undefined =>
    nodes
      .map(node => (node.group.id === id ? node : findNode(node.children, id)))
      .find(Boolean);
  const sessionSiblings = (groupId: string | null) =>
    groupId && groupById(groupId)
      ? (findNode(full.groups, groupId)?.sessions ?? [])
      : full.ungrouped;
  const groupSiblings = (parentId: string | null) =>
    (parentId
      ? (findNode(full.groups, parentId)?.children ?? [])
      : full.groups
    ).map(node => node.group);
  const sessionOf = (id: string) => allRoots.find(item => item.id === id);
  const placeSession = (
    session: Session,
    groupId: string | null,
    anchor: Session | null,
    placement: DropPlacement,
  ) => {
    const list = sessionSiblings(groupId).filter(
      item => item.id !== session.id,
    );
    const index = anchor ? list.findIndex(item => item.id === anchor.id) : -1;
    const position =
      index === -1 ? 0 : placement === 'after' ? index + 1 : index;
    void housekeeping.moveSession(session, groupId, position);
  };
  const placeGroup = (
    group: SessionGroup,
    anchor: SessionGroup,
    placement: DropPlacement,
  ) => {
    if (placement === 'into') {
      const position = groups.filter(
        item => item.parentId === anchor.id && item.id !== group.id,
      ).length;
      void housekeeping.moveGroup(hostId, group.id, anchor.id, position);
      return;
    }
    const list = groupSiblings(anchor.parentId).filter(
      item => item.id !== group.id,
    );
    const index = list.findIndex(item => item.id === anchor.id);
    void housekeeping.moveGroup(
      hostId,
      group.id,
      anchor.parentId,
      placement === 'after' ? index + 1 : index,
    );
  };
  const draggedGroup = (item: DragItem) =>
    item.kind === 'group' && item.hostId === hostId
      ? groupById(item.id)
      : undefined;
  const draggedSession = (item: DragItem) =>
    item.kind === 'session' && item.hostId === hostId
      ? sessionOf(item.id)
      : undefined;
  const openMenu = (key: string) => (open: boolean) =>
    setMenu(open ? key : null);
  const contextMenu = (key: string) => ({
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu(key);
    },
  });
  const sessionActions = (session: Session): RowAction[] => {
    const thread = threadActions?.(session) ?? [];
    const removal = deleteAction?.(session);
    const archived = !!session.archivedAt;
    const siblings = sessionSiblings(session.groupId);
    const index = siblings.findIndex(item => item.id === session.id);
    const ordered = !archived && !session.pinned && index !== -1;
    return [
      {
        label: 'Rename',
        icon: <Pencil />,
        onSelect: () => onRenamingChange(`s:${session.id}`),
      },
      ...(archived
        ? []
        : ([
            {
              label: 'Move to group…',
              icon: <FolderInput />,
              onSelect: () => setMoveTarget({ kind: 'session', session }),
            },
            ...(ordered
              ? [
                  {
                    label: 'Move up',
                    icon: <ArrowUp />,
                    disabled: index === 0,
                    onSelect: () =>
                      void housekeeping.moveSession(
                        session,
                        session.groupId,
                        index - 1,
                      ),
                  },
                  {
                    label: 'Move down',
                    icon: <ArrowDown />,
                    disabled: index === siblings.length - 1,
                    onSelect: () =>
                      void housekeeping.moveSession(
                        session,
                        session.groupId,
                        index + 1,
                      ),
                  },
                ]
              : []),
            {
              label: session.pinned ? 'Unpin' : 'Pin',
              icon: session.pinned ? <PinOff /> : <Pin />,
              onSelect: () =>
                void housekeeping.setPinned(session, !session.pinned),
            },
          ] satisfies RowAction[])),
      'separator',
      ...thread,
      ...(thread.length ? ['separator' as const] : []),
      archived
        ? {
            label: 'Unarchive',
            icon: <ArchiveRestore />,
            onSelect: () => void housekeeping.setArchived(session, false),
          }
        : {
            label: 'Archive',
            icon: <Archive />,
            disabled:
              session.status === 'running' || session.status === 'stopping',
            onSelect: () => void housekeeping.setArchived(session, true),
          },
      ...(removal ? ['separator' as const, removal] : []),
    ];
  };
  const decorate = (
    session: Session,
    depth: number,
    reorderable: boolean,
  ): RowDecoration => {
    const key = `s:${session.id}`;
    const zoneKey = `zone:${key}`;
    return {
      depth,
      dimmed: !!session.archivedAt,
      title:
        renaming === key ? (
          <InlineNameInput
            value={session.title}
            label="Session name"
            maxLength={100}
            onSubmit={title => {
              onRenamingChange(null);
              void housekeeping.renameSession(session, title);
            }}
            onCancel={() => onRenamingChange(null)}
          />
        ) : undefined,
      menu: (
        <RowActionsMenu
          label={`Actions for ${session.title}`}
          actions={sessionActions(session)}
          open={menu === key}
          onOpenChange={openMenu(key)}
        />
      ),
      indicator: drag.indicator(zoneKey),
      item: {
        ...contextMenu(key),
        ...(reorderable && renaming !== key
          ? drag.source({ kind: 'session', hostId, id: session.id })
          : {}),
        ...(reorderable
          ? drag.zone({
              key: zoneKey,
              accepts: item =>
                draggedSession(item) && item.id !== session.id
                  ? ['before', 'after']
                  : [],
              onDrop: (item, placement) => {
                const dragged = draggedSession(item);
                if (dragged)
                  placeSession(dragged, session.groupId, session, placement);
              },
            })
          : {}),
      },
    };
  };
  const startGroup = async (parentId: string | null) => {
    if (parentId) onToggleCollapsed(collapseKey(hostId, parentId), false);
    const id = await housekeeping.createGroup(hostId, parentId, 'New group');
    if (id) onRenamingChange(`g:${id}`);
  };
  const groupActions = (node: GroupNode): RowAction[] => {
    const { group } = node;
    const siblings = groupSiblings(group.parentId);
    const index = siblings.findIndex(item => item.id === group.id);
    return [
      {
        label: 'New session',
        icon: <SquarePen />,
        onSelect: () => housekeeping.createInGroup(hostId, group),
      },
      {
        label: 'New subgroup',
        icon: <FolderPlus />,
        disabled: !canNestUnder(group, groups),
        onSelect: () => void startGroup(group.id),
      },
      'separator',
      {
        label: 'Rename',
        icon: <Pencil />,
        onSelect: () => onRenamingChange(`g:${group.id}`),
      },
      {
        label: 'Edit defaults…',
        icon: <SlidersHorizontal />,
        onSelect: () => setDefaultsGroup(group),
      },
      {
        label: 'Move to…',
        icon: <FolderInput />,
        onSelect: () => setMoveTarget({ kind: 'group', group }),
      },
      {
        label: 'Move up',
        icon: <ArrowUp />,
        disabled: index <= 0,
        onSelect: () =>
          void housekeeping.moveGroup(
            hostId,
            group.id,
            group.parentId,
            index - 1,
          ),
      },
      {
        label: 'Move down',
        icon: <ArrowDown />,
        disabled: index === siblings.length - 1,
        onSelect: () =>
          void housekeeping.moveGroup(
            hostId,
            group.id,
            group.parentId,
            index + 1,
          ),
      },
      'separator',
      {
        label: 'Delete group…',
        icon: <Trash2 />,
        destructive: true,
        onSelect: () => setDeleting(group),
      },
    ];
  };
  const groupRow = (node: GroupNode): ReactNode => {
    const { group, depth } = node;
    const key = `g:${group.id}`;
    const zoneKey = `zone:${key}`;
    const stored = collapseKey(hostId, group.id);
    const expanded = searching || !isCollapsed(stored);
    const editing = renaming === key;
    return (
      <li
        key={key}
        className="flex flex-col gap-0.5"
        data-sidebar-section={depth === 1 ? 'group' : undefined}
      >
        <ListRow
          tone="sidebar"
          size="sm"
          heading
          level={depth - 1}
          data-group-id={group.id}
          leading={
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'size-3 transition-transform duration-base ease-out',
                !expanded && '-rotate-90',
              )}
            />
          }
          title={
            editing ? (
              <InlineNameInput
                value={group.name}
                label="Group name"
                maxLength={80}
                onSubmit={name => {
                  onRenamingChange(null);
                  void housekeeping.renameGroup(hostId, group.id, name);
                }}
                onCancel={() => onRenamingChange(null)}
              />
            ) : (
              group.name
            )
          }
          trailing={!expanded && node.count > 0 ? node.count : undefined}
          actionsPlacement="overlay"
          actions={
            <>
              <IconButton
                label={`New session in ${group.name}`}
                size={20}
                tone="sidebar"
                tooltipSide="bottom"
                onClick={() => housekeeping.createInGroup(hostId, group)}
              >
                <Plus />
              </IconButton>
              <RowActionsMenu
                label={`Actions for ${group.name}`}
                actions={groupActions(node)}
                open={menu === key}
                onOpenChange={openMenu(key)}
              />
            </>
          }
          dropIndicator={toDropIndicator(drag.indicator(zoneKey))}
          className={cn(editing && 'focus-ring-within')}
          mainProps={{
            'aria-expanded': expanded,
            'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${group.name}`,
          }}
          onClick={
            editing ? undefined : () => onToggleCollapsed(stored, expanded)
          }
          {...contextMenu(key)}
          {...(editing
            ? {}
            : drag.source({ kind: 'group', hostId, id: group.id }))}
          {...drag.zone({
            key: zoneKey,
            accepts: item => {
              if (draggedSession(item)) return ['into'];
              const dragged = draggedGroup(item);
              if (!dragged || dragged.id === group.id) return [];
              const parent = groupById(group.parentId) ?? null;
              return [
                ...(canReparent(dragged, parent, groups)
                  ? (['before', 'after'] as const)
                  : []),
                ...(canReparent(dragged, group, groups)
                  ? (['into'] as const)
                  : []),
              ];
            },
            onDrop: (item, where) => {
              const session = draggedSession(item);
              if (session) {
                onToggleCollapsed(stored, false);
                void housekeeping.moveSession(session, group.id, 0);
                return;
              }
              const dragged = draggedGroup(item);
              if (dragged) placeGroup(dragged, group, where);
            },
          })}
        />
        {expanded && (
          <ul aria-label={group.name} className="flex flex-col gap-0.5">
            {node.children.map(groupRow)}
            {node.sessions.flatMap(session =>
              renderRoot(session, decorate(session, depth, true)),
            )}
          </ul>
        )}
      </li>
    );
  };
  const ungroupedKey = 'zone:ungrouped';
  const showUngroupedLabel =
    groups.length > 0 && (shown.ungrouped.length > 0 || !!drag.dragging);
  const moving = moveTarget;
  return (
    <>
      {shown.pinned.flatMap(session =>
        renderRoot(session, decorate(session, 0, false)),
      )}
      {visibleGroups.map(groupRow)}
      {showUngroupedLabel && (
        <li>
          <ListRow
            tone="sidebar"
            size="sm"
            density="tree"
            heading
            title="Ungrouped"
            dropIndicator={toDropIndicator(drag.indicator(ungroupedKey))}
            {...drag.zone({
              key: ungroupedKey,
              accepts: item =>
                draggedSession(item) || draggedGroup(item) ? ['into'] : [],
              onDrop: item => {
                const session = draggedSession(item);
                if (session) void housekeeping.moveSession(session, null, 0);
                const group = draggedGroup(item);
                if (group)
                  void housekeeping.moveGroup(
                    hostId,
                    group.id,
                    null,
                    groupSiblings(null).length,
                  );
              },
            })}
          />
        </li>
      )}
      {shown.ungrouped.flatMap(session =>
        renderRoot(session, decorate(session, 0, true)),
      )}
      {automations}
      {full.archived.length > 0 && (
        <li>
          <ListRow
            tone="sidebar"
            size="sm"
            heading
            leading={<Archive />}
            title={`Archived (${full.archived.length})`}
            trailing={
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'size-3 text-sidebar-icon transition-transform duration-base ease-out',
                  !archivedOpen && '-rotate-90',
                )}
              />
            }
            mainProps={{ 'aria-expanded': archivedOpen }}
            onClick={() => onArchivedOpenChange(!archivedOpen)}
          />
          {archivedOpen && (
            <ul
              aria-label="Archived sessions"
              className="flex flex-col gap-0.5"
            >
              {shown.archived.flatMap(session =>
                renderRoot(session, decorate(session, 0, false)),
              )}
              {shown.archived.length === 0 && (
                <li>
                  <ListRow
                    tone="sidebar"
                    size="sm"
                    density="tree"
                    heading
                    title="No matching archived sessions."
                  />
                </li>
              )}
            </ul>
          )}
        </li>
      )}
      <MoveToGroupDialog
        key={
          moving
            ? moving.kind === 'session'
              ? moving.session.id
              : moving.group.id
            : 'move-closed'
        }
        open={!!moving}
        onOpenChange={open => {
          if (!open) setMoveTarget(null);
        }}
        title={
          moving?.kind === 'group'
            ? `Move “${moving.group.name}” to`
            : `Move “${moving?.session.title ?? ''}” to`
        }
        groups={groups}
        currentId={
          moving?.kind === 'group'
            ? moving.group.parentId
            : (moving?.session.groupId ?? null)
        }
        rootLabel={moving?.kind === 'group' ? 'Top level' : 'Ungrouped'}
        isAllowed={candidate =>
          moving?.kind === 'group'
            ? canReparent(moving.group, candidate, groups)
            : true
        }
        onMove={groupId => {
          if (!moving) return;
          if (moving.kind === 'session')
            void housekeeping.moveSession(moving.session, groupId, 0);
          else
            void housekeeping.moveGroup(
              hostId,
              moving.group.id,
              groupId,
              groupSiblings(groupId).filter(item => item.id !== moving.group.id)
                .length,
            );
        }}
        onCreate={
          moving?.kind === 'session'
            ? name => {
                const session = moving.session;
                void housekeeping
                  .createGroup(hostId, null, name)
                  .then(groupId => {
                    if (groupId)
                      void housekeeping.moveSession(session, groupId, 0);
                  });
              }
            : undefined
        }
      />
      <GroupDefaultsDialog
        key={defaultsGroup?.id ?? 'defaults-closed'}
        group={defaultsGroup}
        profiles={profiles}
        onOpenChange={open => {
          if (!open) setDefaultsGroup(null);
        }}
        onSave={defaults =>
          defaultsGroup
            ? housekeeping.updateDefaults(hostId, defaultsGroup.id, defaults)
            : Promise.resolve(false)
        }
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={open => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.name ?? 'group'}?`}
        description={`No sessions are deleted. Its sessions and subgroups move to ${
          groupById(deleting?.parentId ?? null)?.name ?? 'Ungrouped'
        }.`}
        confirmLabel="Delete group"
        pendingLabel="Deleting…"
        onConfirm={() =>
          deleting ? housekeeping.deleteGroup(hostId, deleting.id) : undefined
        }
      />
    </>
  );
}
