import { createContext } from 'react';
import type { PullRequestReference } from '@nesvo/contracts';
import type { PullRequestApi } from '@/entities/pull-request';
import type { FileTarget } from './message-link-target';

export type MessageLinkScope = {
  directory: string;
  ports: ReadonlySet<number>;
  hostId: string;
  hostName: string;
  local: boolean;
  pullRequests: Pick<PullRequestApi, 'readPullRequest'> | null;
  openPullRequest: (reference: PullRequestReference) => void;
  openFile: (target: FileTarget) => void;
  fileExists: (path: string) => Promise<boolean>;
  internalLink: (
    kind: 'session' | 'inbox',
    id: string,
    hostId?: string,
  ) => { label: string; open: () => void } | null;
};

export const MessageLinkContext = createContext<MessageLinkScope | null>(null);
