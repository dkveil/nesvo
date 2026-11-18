import type { SiteDatabase } from '../server/database';
import { hashSecret } from './share-tokens';

export const SHARE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const SHARE_RATE_LIMIT_ATTEMPTS = 10;

export type RateLimitDecision =
  { status: 'allowed' } | { status: 'limited'; retryAfterSeconds: number };

export const consumeShareAttempt = async (
  db: SiteDatabase,
  clientAddress: string,
  now: number,
): Promise<RateLimitDecision> => {
  const windowStart = now - (now % SHARE_RATE_LIMIT_WINDOW_MS);
  const clientKey = await hashSecret(`share-client:${clientAddress}`);
  const row = await db
    .prepare(
      `INSERT INTO share_rate_limits (client_key, window_start, attempts)
       VALUES (?, ?, 1)
       ON CONFLICT (client_key, window_start)
       DO UPDATE SET attempts = attempts + 1
       RETURNING attempts`,
    )
    .bind(clientKey, windowStart)
    .first<{ attempts: number }>();
  const attempts = row?.attempts ?? SHARE_RATE_LIMIT_ATTEMPTS + 1;
  if (attempts <= SHARE_RATE_LIMIT_ATTEMPTS) return { status: 'allowed' };
  return {
    status: 'limited',
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStart + SHARE_RATE_LIMIT_WINDOW_MS - now) / 1000),
    ),
  };
};

export const deleteStaleRateLimits = async (
  db: SiteDatabase,
  now: number,
): Promise<number> => {
  const result = await db
    .prepare('DELETE FROM share_rate_limits WHERE window_start < ?')
    .bind(now - SHARE_RATE_LIMIT_WINDOW_MS)
    .run();
  return result.meta.changes;
};
