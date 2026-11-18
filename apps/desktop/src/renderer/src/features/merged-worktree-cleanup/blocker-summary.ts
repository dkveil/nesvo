import {
  mergedCleanupBlockerMessages,
  type MergedWorktreeCleanup,
} from '@nesvo/contracts';

export const blockerSummary = (cleanup: MergedWorktreeCleanup): string =>
  cleanup.blockers
    .map(blocker => mergedCleanupBlockerMessages[blocker])
    .join(' ');
