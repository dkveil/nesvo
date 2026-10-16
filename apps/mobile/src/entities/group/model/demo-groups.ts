import type { SessionGroup } from '@shared/api/host';

export const demoGroups: SessionGroup[] = [
  { id: 'demo-workspace', name: 'Workspace', parentId: null, order: 0 },
  { id: 'demo-mobile', name: 'Aplikacja mobilna', parentId: 'demo-workspace', order: 0 },
];
