import type { HTMLAttributes, ReactNode } from 'react';
import type { SessionGroup, SessionGroupDefaults } from '@nesvo/contracts';
import type { Session } from '@/entities/session';

export type SidebarHousekeeping = {
  supports: (hostId: string) => boolean;
  groups: (hostId: string) => SessionGroup[];
  createGroup: (
    hostId: string,
    parentId: string | null,
    name: string,
  ) => Promise<string | null>;
  renameGroup: (hostId: string, groupId: string, name: string) => Promise<void>;
  updateDefaults: (
    hostId: string,
    groupId: string,
    defaults: SessionGroupDefaults,
  ) => Promise<boolean>;
  moveGroup: (
    hostId: string,
    groupId: string,
    parentId: string | null,
    position: number,
  ) => Promise<void>;
  deleteGroup: (hostId: string, groupId: string) => Promise<void>;
  moveSession: (
    session: Session,
    groupId: string | null,
    position: number,
  ) => Promise<void>;
  renameSession: (session: Session, title: string) => Promise<void>;
  setPinned: (session: Session, pinned: boolean) => Promise<void>;
  setArchived: (session: Session, archived: boolean) => Promise<void>;
  createInGroup: (hostId: string, group: SessionGroup) => void;
  error: string;
  clearError: () => void;
};

export type DragItem = {
  kind: 'session' | 'group';
  hostId: string;
  id: string;
};

export type DropPlacement = 'before' | 'after' | 'into';

export type RowDecoration = {
  depth: number;
  menu?: ReactNode;
  title?: ReactNode;
  dimmed?: boolean;
  item?: HTMLAttributes<HTMLLIElement>;
  indicator?: DropPlacement | null;
};
