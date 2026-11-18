import {
  Bell,
  Blocks,
  Database,
  FolderGit2,
  GitFork,
  Info,
  Keyboard,
  Monitor,
  Network,
  Palette,
  ScanSearch,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

export type SettingsPage =
  | 'general'
  | 'appearance'
  | 'shortcuts'
  | 'defaults'
  | 'worktree-recipes'
  | 'notifications'
  | 'code-review'
  | 'session-control'
  | 'computers'
  | 'phone'
  | 'repositories'
  | 'account'
  | 'data'
  | 'about'
  | 'components';

type SettingsPageEntry = {
  id: SettingsPage;
  label: string;
  icon: LucideIcon;
  group: string;
  keywords: string;
  wide?: boolean;
};

export const settingsPages: SettingsPageEntry[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings2,
    group: '',
    keywords:
      'connection host providers claude codex status sign in refresh running apps ports',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    group: '',
    keywords: 'color scheme theme light dark system',
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    icon: Keyboard,
    group: '',
    keywords: 'keys hotkeys bindings palette navigation',
  },
  {
    id: 'defaults',
    label: 'Defaults',
    icon: SlidersHorizontal,
    group: '',
    keywords: 'new session provider model permission mode folder worktree',
  },
  {
    id: 'worktree-recipes',
    label: 'Worktree recipes',
    icon: GitFork,
    group: '',
    keywords:
      'worktree recipe setup command copy files env ports tag temporary cleanup repository',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    group: '',
    keywords: 'desktop alerts approvals finished runs test',
  },
  {
    id: 'code-review',
    label: 'Code review',
    icon: ScanSearch,
    group: '',
    keywords:
      'pull request reviewer agent profiles conventions rules findings github',
  },
  {
    id: 'session-control',
    label: 'Session control',
    icon: Network,
    group: '',
    keywords:
      'coordinator orchestrator agents child sessions tools policy plans worktrees modes',
  },
  {
    id: 'computers',
    label: 'Computers',
    icon: Monitor,
    group: 'Connections',
    keywords: 'ssh remote vps host machine add connect',
  },
  {
    id: 'phone',
    label: 'Phone access',
    icon: Smartphone,
    group: 'Connections',
    keywords: 'mobile pair device revoke',
  },
  {
    id: 'repositories',
    label: 'Tracked repositories',
    icon: FolderGit2,
    group: 'Connections',
    keywords: 'github pull requests repository track owner name checkout',
  },
  {
    id: 'account',
    label: 'Account and limits',
    icon: UserRound,
    group: 'Account',
    keywords: 'usage quota limits reset weekly',
  },
  {
    id: 'data',
    label: 'Data',
    icon: Database,
    group: 'System',
    keywords: 'backup database export markdown sqlite',
  },
  {
    id: 'about',
    label: 'About',
    icon: Info,
    group: 'System',
    keywords:
      'version electron node chrome platform data folder logs licenses diagnostics',
  },
  ...(import.meta.env.DEV
    ? [
        {
          id: 'components' as const,
          label: 'Components',
          icon: Blocks,
          group: 'Development',
          keywords: 'design system catalog library ui primitives',
          wide: true,
        },
      ]
    : []),
];

export const matchesSettingsPage = (entry: SettingsPageEntry, query: string) =>
  `${entry.label} ${entry.keywords}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
