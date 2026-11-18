type ShortcutGroup = 'General' | 'Navigation' | 'Panels' | 'Composer';

type ShortcutEntry = {
  keys: string;
  label: string;
  group: ShortcutGroup;
};

export const shortcuts = {
  commandPalette: {
    keys: 'Ctrl Shift P',
    label: 'Open the command palette',
    group: 'General',
  },
  goToSession: {
    keys: 'Ctrl P',
    label: 'Go to session',
    group: 'General',
  },
  searchHistory: {
    keys: 'Ctrl K',
    label: 'Search all history',
    group: 'General',
  },
  searchHistoryAlternate: {
    keys: 'Ctrl Shift F',
    label: 'Search all history',
    group: 'General',
  },
  newSession: { keys: 'Ctrl N', label: 'New session', group: 'General' },
  settings: { keys: 'Ctrl ,', label: 'Open settings', group: 'General' },
  nextSession: {
    keys: 'Alt ↓',
    label: 'Next session in the sidebar',
    group: 'Navigation',
  },
  previousSession: {
    keys: 'Alt ↑',
    label: 'Previous session in the sidebar',
    group: 'Navigation',
  },
  nextNeedsMe: {
    keys: 'Ctrl J',
    label: 'Next session that needs me',
    group: 'Navigation',
  },
  lastSession: {
    keys: 'Ctrl `',
    label: 'Back to the previous session',
    group: 'Navigation',
  },
  sidebarSection: {
    keys: 'Ctrl 1–9',
    label: 'Jump to a computer or group in the sidebar',
    group: 'Navigation',
  },
  toggleSidebar: {
    keys: 'Ctrl B',
    label: 'Toggle the sidebar',
    group: 'Panels',
  },
  files: {
    keys: 'Ctrl Shift E',
    label: 'Open files for the current session',
    group: 'Panels',
  },
  reviewPullRequest: {
    keys: 'Ctrl Shift G',
    label: 'Review the pull request of the current session',
    group: 'Panels',
  },
  focusComposer: {
    keys: 'Esc',
    label: 'Close a panel, or return focus from it to the composer',
    group: 'Panels',
  },
  permissionMode: {
    keys: 'Shift Tab',
    label: 'Cycle the permission mode for the next turn',
    group: 'Composer',
  },
  send: { keys: 'Enter', label: 'Send the message', group: 'Composer' },
  newLine: { keys: 'Shift Enter', label: 'New line', group: 'Composer' },
} as const satisfies Record<string, ShortcutEntry>;

export type ShortcutId = keyof typeof shortcuts;

export const shortcutGroups: ShortcutGroup[] = [
  'General',
  'Navigation',
  'Panels',
  'Composer',
];

export const shortcutKeys = (id: ShortcutId): string => shortcuts[id].keys;

export const isComposing = (event: KeyboardEvent) =>
  event.isComposing || event.keyCode === 229;
