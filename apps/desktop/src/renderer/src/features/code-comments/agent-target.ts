import type { CodeComment } from '@nesvo/contracts';

export type AgentCommentTarget = {
  title: string;
  blockedReason: string;
  preferred: boolean;
  add: (comment: Omit<CodeComment, 'offset'>) => boolean;
};
