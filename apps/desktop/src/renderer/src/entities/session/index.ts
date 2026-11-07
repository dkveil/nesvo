export type SessionRole = 'orchestrator' | 'worker' | 'standalone';
export type SessionStatus = 'ready' | 'planning' | 'review' | 'approval';
export type Provider = 'Claude Code' | 'Codex';

export type Message = {
  id: string;
  author: 'operator' | 'agent';
  body: string;
};

export type PreviewSession = {
  id: string;
  title: string;
  provider: Provider;
  model: string;
  role: SessionRole;
  status: SessionStatus;
  directory: string;
  parentId?: string;
  messages: Message[];
};

export const roleLabels: Record<SessionRole, string> = {
  orchestrator: 'Orkiestrator',
  worker: 'Worker',
  standalone: 'Samodzielna',
};

export const statusLabels: Record<SessionStatus, string> = {
  ready: 'Gotowa',
  planning: 'Planowanie',
  review: 'Do odbioru',
  approval: 'Czeka na zgodę',
};
