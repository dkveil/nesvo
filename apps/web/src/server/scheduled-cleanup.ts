import { deleteStaleRateLimits } from '../shares/rate-limit';
import { deleteExpiredShares } from '../shares/share-store';
import type { SiteDatabase } from './database';

export const runScheduledCleanup = async (
  db: SiteDatabase | undefined,
  now: number,
): Promise<{ shares: number; rateLimits: number }> => {
  if (!db) return { shares: 0, rateLimits: 0 };
  const shares = await deleteExpiredShares(db, now);
  const rateLimits = await deleteStaleRateLimits(db, now);
  return { shares, rateLimits };
};
