import type { Computer, SessionGroup } from '@nesvo/contracts';
import {
  BookOpen,
  CalendarClock,
  ChartNoAxesColumn,
  FileCode2,
  FolderOpen,
  GitPullRequest,
  Hand,
  History,
  Inbox,
  Keyboard,
  PanelLeft,
  Settings,
  SquarePen,
  SquareTerminal,
  Undo2,
  Workflow,
} from 'lucide-react';
import {
  sessionProjectLabel,
  sessionFilterLabels,
  sessionStatusLabel,
  type Session,
  type SessionFilterKeys,
} from '@/entities/session';
import type {
  PaletteCommand,
  PaletteSession,
} from '@/features/command-palette';
import { entityKey } from '@/shared/lib/host-key';
import { shortcutKeys } from '@/shared/lib/keyboard-shortcuts';

type Action = (() => void) | undefined;

export type WorkspaceCommandActions = {
  newSession: () => void;
  inbox: () => void;
  workflows: () => void;
  automations: Action;
  pullRequests: Action;
  costs: Action;
  settings: () => void;
  shortcuts: () => void;
  toggleSidebar: Action;
  files: Action;
  diff: Action;
  skills: Action;
  searchHistory: () => void;
  openInTerminal: Action;
  nextNeedsMe: () => void;
  needsMeCount: number;
  lastSession: Action;
  conversation: PaletteCommand[];
};

type CommandSpec = Omit<PaletteCommand, 'run'> & { run: Action };

const available = (command: CommandSpec): command is PaletteCommand =>
  !!command.run;

export function workspaceCommands(
  actions: WorkspaceCommandActions,
): PaletteCommand[] {
  const specs: CommandSpec[] = [
    {
      id: 'next-needs-me',
      label: 'Jump to next session that needs me',
      icon: <Hand />,
      shortcut: shortcutKeys('nextNeedsMe'),
      keywords: 'attention approval review decision waiting',
      description:
        actions.needsMeCount > 0
          ? `${actions.needsMeCount} waiting for you`
          : 'Nothing is waiting for you',
      disabled: actions.needsMeCount === 0,
      run: actions.nextNeedsMe,
    },
    {
      id: 'new-session',
      label: 'New session',
      icon: <SquarePen />,
      shortcut: shortcutKeys('newSession'),
      keywords: 'create thread start',
      run: actions.newSession,
    },
    {
      id: 'last-session',
      label: 'Back to the previous session',
      icon: <Undo2 />,
      shortcut: shortcutKeys('lastSession'),
      keywords: 'toggle recent last',
      run: actions.lastSession,
    },
    {
      id: 'inbox',
      label: 'Open Inbox',
      icon: <Inbox />,
      keywords: 'actions approvals reviews',
      run: actions.inbox,
    },
    {
      id: 'workflows',
      label: 'Open Workflows',
      icon: <Workflow />,
      keywords: 'steps graph',
      run: actions.workflows,
    },
    {
      id: 'automations',
      label: 'Open Automations',
      icon: <CalendarClock />,
      keywords: 'schedule scheduled jobs',
      run: actions.automations,
    },
    {
      id: 'pull-requests',
      label: 'Open Pull requests',
      icon: <GitPullRequest />,
      keywords: 'github pr review',
      run: actions.pullRequests,
    },
    {
      id: 'costs',
      label: 'Open Costs',
      icon: <ChartNoAxesColumn />,
      keywords: 'budget spend usage',
      run: actions.costs,
    },
    {
      id: 'files',
      label: 'Open files panel',
      icon: <FolderOpen />,
      shortcut: shortcutKeys('files'),
      keywords: 'explorer tree current session',
      run: actions.files,
    },
    {
      id: 'diff',
      label: 'Open saved diff panel',
      icon: <FileCode2 />,
      keywords: 'changes review result current session',
      run: actions.diff,
    },
    {
      id: 'skills',
      label: 'Open skills panel',
      icon: <BookOpen />,
      keywords: 'shared library current session',
      run: actions.skills,
    },
    ...actions.conversation,
    {
      id: 'search-history',
      label: 'Search all history',
      icon: <History />,
      shortcut: shortcutKeys('searchHistory'),
      keywords: 'messages find full text',
      run: actions.searchHistory,
    },
    {
      id: 'open-in-terminal',
      label: 'Open current session in terminal',
      icon: <SquareTerminal />,
      keywords: 'resume cli shell console external',
      run: actions.openInTerminal,
    },
    {
      id: 'toggle-sidebar',
      label: 'Toggle sidebar',
      icon: <PanelLeft />,
      shortcut: shortcutKeys('toggleSidebar'),
      keywords: 'hide show collapse expand',
      run: actions.toggleSidebar,
    },
    {
      id: 'settings',
      label: 'Open Settings',
      icon: <Settings />,
      shortcut: shortcutKeys('settings'),
      keywords: 'preferences configuration',
      run: actions.settings,
    },
    {
      id: 'keyboard-shortcuts',
      label: 'Show keyboard shortcuts',
      icon: <Keyboard />,
      keywords: 'keys bindings hotkeys help',
      run: actions.shortcuts,
    },
  ];
  return specs.filter(available);
}

function groupLabel(groupId: string | null, groups: SessionGroup[]) {
  const names: string[] = [];
  let current = groupId ? groups.find(group => group.id === groupId) : null;
  while (current) {
    names.unshift(current.name);
    const parentId = current.parentId;
    current = parentId ? groups.find(group => group.id === parentId) : null;
  }
  return names.join(' / ');
}

function paletteStatus(session: Session, keys: SessionFilterKeys) {
  const key = entityKey(session);
  if (keys['needs-me'].has(key)) return sessionFilterLabels['needs-me'];
  if (keys.running.has(key) || keys.failed.has(key))
    return sessionStatusLabel(session);
  return '';
}

export function paletteSessions(
  sessions: Session[],
  computers: Computer[],
  groupsOf: (hostId: string) => SessionGroup[],
  keys: SessionFilterKeys,
): PaletteSession[] {
  return sessions
    .filter(session => !session.archivedAt)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(session => ({
      key: entityKey(session),
      title: session.title,
      folder: sessionProjectLabel(session),
      group: groupLabel(session.groupId ?? null, groupsOf(session.hostId)),
      computer:
        computers.length > 1
          ? (computers.find(computer => computer.id === session.hostId)?.name ??
            session.hostId)
          : '',
      provider: session.provider,
      status: paletteStatus(session, keys),
    }));
}
