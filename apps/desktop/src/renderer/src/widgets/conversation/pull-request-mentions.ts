import { createContext, type ReactNode } from 'react';
import type { PullRequestReference } from '@nesvo/contracts';

export type PullRequestMentionRenderer = (
  reference: PullRequestReference,
) => ReactNode;

export const PullRequestMentionContext =
  createContext<PullRequestMentionRenderer | null>(null);
