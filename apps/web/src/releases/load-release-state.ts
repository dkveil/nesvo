import type { SiteDatabase } from '@/server/database';
import type { SiteConfig } from '@/server/site-config';

import { fetchLatestRelease, type Fetcher } from './fetch-latest-release';
import { releaseStateSchema, type ReleaseState } from './release-state';

export const RELEASE_CACHE_TTL_MS = 10 * 60 * 1000;

type CachedRelease = {
  state: ReleaseState;
  fetchedAt: number;
};

type LoadReleaseStateParams = {
  db: SiteDatabase | null;
  config: SiteConfig;
  now?: number;
  fetcher?: Fetcher;
};

const readCache = async (
  db: SiteDatabase,
  repository: string,
): Promise<CachedRelease | null> => {
  const row = await db
    .prepare('SELECT state, fetched_at FROM release_cache WHERE repository = ?')
    .bind(repository)
    .first<{ state: string; fetched_at: number }>();
  if (!row) return null;
  try {
    const state = releaseStateSchema.safeParse(JSON.parse(row.state));
    return state.success
      ? { state: state.data, fetchedAt: row.fetched_at }
      : null;
  } catch {
    return null;
  }
};

const writeCache = async (
  db: SiteDatabase,
  repository: string,
  state: ReleaseState,
  now: number,
): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO release_cache (repository, state, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT (repository)
       DO UPDATE SET state = excluded.state, fetched_at = excluded.fetched_at`,
    )
    .bind(repository, JSON.stringify(state), now)
    .run();
};

const safely = async <TResult>(
  task: () => Promise<TResult>,
  fallback: TResult,
): Promise<TResult> => {
  try {
    return await task();
  } catch {
    return fallback;
  }
};

export const loadReleaseState = async ({
  db,
  config,
  now = Date.now(),
  fetcher,
}: LoadReleaseStateParams): Promise<ReleaseState> => {
  if (!db) return fetchLatestRelease(config, fetcher);
  const repository = config.releaseRepository;
  const cached = await safely(() => readCache(db, repository), null);
  if (cached && now - cached.fetchedAt < RELEASE_CACHE_TTL_MS) {
    return cached.state;
  }
  const fresh = await fetchLatestRelease(config, fetcher);
  if (fresh.status === 'unavailable') return cached?.state ?? fresh;
  await safely(() => writeCache(db, repository, fresh, now), undefined);
  return fresh;
};
