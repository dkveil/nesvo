import {
  Bell,
  Blocks,
  Database,
  KeyRound,
  FolderGit2,
  GitFork,
  History,
  Import,
  Inbox,
  Info,
  Keyboard,
  Lightbulb,
  Monitor,
  Network,
  Palette,
  Plug,
  ScanSearch,
  Settings2,
  Share2,
  ShieldCheck,
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
  | 'permissions'
  | 'worktree-recipes'
  | 'notifications'
  | 'code-review'
  | 'session-control'
  | 'lessons'
  | 'inbox-rules'
  | 'workflows'
  | 'computers'
  | 'devices'
  | 'change-history'
  | 'phone'
  | 'repositories'
  | 'sharing'
  | 'account'
  | 'mcp'
  | 'data'
  | 'import'
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
    id: 'permissions',
    label: 'Permissions',
    icon: ShieldCheck,
    group: '',
    keywords: 'allow rules Claude Codex full access session project',
  },
  {
    id: 'worktree-recipes',
    label: 'Worktrees',
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
    id: 'mcp',
    label: 'MCP',
    icon: Plug,
    group: '',
    keywords:
      'servers tools provider profile authorize login OAuth reconnect sign out',
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
    id: 'workflows',
    label: 'Workflows',
    icon: Blocks,
    group: '',
    keywords: 'gate rules learning propose fix reject verification',
  },
  {
    id: 'lessons',
    label: 'Lessons',
    icon: Lightbulb,
    group: '',
    keywords:
      'learning incidents insights rules review date proposals daily cost norm retire',
  },
  {
    id: 'inbox-rules',
    label: 'Inbox rules',
    icon: Inbox,
    group: '',
    keywords:
      'inbox rules hold notify ask before push merge approval gate route parent decisions presets',
  },
  {
    id: 'computers',
    label: 'Computers',
    icon: Monitor,
    group: 'Connections',
    keywords: 'ssh remote vps host machine add connect',
  },
  {
    id: 'change-history',
    label: 'Change history',
    icon: History,
    group: '',
    keywords: 'configuration proposals devices undo review history',
  },
  {
    id: 'devices',
    label: 'Devices',
    icon: KeyRound,
    group: 'Connections',
    keywords: 'external inbox cli mcp token revoke install',
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
    id: 'sharing',
    label: 'Sharing',
    icon: Share2,
    group: 'Connections',
    keywords: 'share workflow link import revoke expiry site origin nesvo.dev',
  },
  {
    id: 'account',
    label: 'Account and limits',
    icon: UserRound,
    group: 'Account',
    keywords: 'usage quota limits reset weekly',
  },
  {
    id: 'import',
    label: 'Import',
    icon: Import,
    group: 'System',
    keywords: 'move conversations projects groups sessions T3 Code Agent Deck',
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
