import {
  Monitor,
  Palette,
  Settings2,
  Smartphone,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

export type SettingsPage =
  'general' | 'appearance' | 'computers' | 'phone' | 'account';

type SettingsPageEntry = {
  id: SettingsPage;
  label: string;
  icon: LucideIcon;
  group: string;
  keywords: string;
};

export const settingsPages: SettingsPageEntry[] = [
  {
    id: 'general',
    label: 'General',
    icon: Settings2,
    group: '',
    keywords: 'connection host providers claude codex status sign in refresh',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: Palette,
    group: '',
    keywords: 'color scheme theme light dark system',
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
    id: 'account',
    label: 'Account and limits',
    icon: UserRound,
    group: 'Account',
    keywords: 'usage quota limits reset weekly',
  },
];

export const matchesSettingsPage = (entry: SettingsPageEntry, query: string) =>
  `${entry.label} ${entry.keywords}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
