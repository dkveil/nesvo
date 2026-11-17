import type { ColorScheme } from '@nesvo/contracts';
import {
  directoryLabel,
  sessionStatusLabel,
  type Session,
} from '@/entities/session';
import { entityKey } from '@/shared/lib/host-key';
import { shortcutLabel } from '@/shared/lib/shortcut';

export type PaletteActions = {
  automationsAvailable: boolean;
  onNewSession: () => void;
  onInbox: () => void;
  onWorkflows: () => void;
  onAutomations: () => void;
  onSettings: () => void;
  onToggleSidebar: () => void;
  onColorScheme: (scheme: ColorScheme) => void;
  onSelectSession: (key: string) => void;
};

export type PaletteItem = {
  id: string;
  kind: 'Command' | 'Session';
  title: string;
  subtitle: string;
  shortcut?: string;
  run: () => void;
};

export const maxVisibleItems = 10;

const command = (
  id: string,
  title: string,
  run: () => void,
  shortcut?: string,
): PaletteItem => ({
  id: `command-${id}`,
  kind: 'Command',
  title,
  subtitle: '',
  shortcut,
  run,
});

const schemeTitles: Record<ColorScheme, string> = {
  dark: 'Switch theme: Dark',
  light: 'Switch theme: Light',
  system: 'Switch theme: System',
};

const commandItems = (actions: PaletteActions): PaletteItem[] => [
  command(
    'new-session',
    'New session',
    actions.onNewSession,
    shortcutLabel('N'),
  ),
  command('inbox', 'Go to Inbox', actions.onInbox),
  command('workflows', 'Go to Workflows', actions.onWorkflows),
  ...(actions.automationsAvailable
    ? [command('automations', 'Go to Automations', actions.onAutomations)]
    : []),
  command('settings', 'Open settings', actions.onSettings),
  command(
    'sidebar',
    'Toggle sidebar',
    actions.onToggleSidebar,
    shortcutLabel('B'),
  ),
  ...(['dark', 'light', 'system'] as const).map(scheme =>
    command(`theme-${scheme}`, schemeTitles[scheme], () =>
      actions.onColorScheme(scheme),
    ),
  ),
];

const sessionItems = (
  sessions: Session[],
  actions: PaletteActions,
): PaletteItem[] =>
  [...sessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(session => ({
      id: `session-${entityKey(session)}`,
      kind: 'Session' as const,
      title: session.title,
      subtitle: `${directoryLabel(session.directory)} · ${sessionStatusLabel(session)}`,
      run: () => actions.onSelectSession(entityKey(session)),
    }));

export const filterPaletteItems = (
  sessions: Session[],
  actions: PaletteActions,
  query: string,
) => {
  const needle = query.trim().toLowerCase();
  return [...commandItems(actions), ...sessionItems(sessions, actions)].filter(
    item =>
      !needle ||
      item.title.toLowerCase().includes(needle) ||
      item.subtitle.toLowerCase().includes(needle),
  );
};
