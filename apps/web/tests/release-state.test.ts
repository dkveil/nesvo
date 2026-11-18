import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  fetchLatestRelease,
  parseChecksums,
  type Fetcher,
} from '@/releases/fetch-latest-release';
import {
  loadReleaseState,
  RELEASE_CACHE_TTL_MS,
} from '@/releases/load-release-state';
import { readSiteConfig } from '@/server/site-config';

import {
  createTestDatabase,
  type TestDatabase,
} from './support/sqlite-database';

const config = readSiteConfig({ NESVO_RELEASE_REPO: 'dkveil/nesvo' });
const ARM_SUM = 'b'.repeat(64);
const WINDOWS_SUM = 'c'.repeat(64);
const DOWNLOAD = 'https://github.com/dkveil/nesvo/releases/download/v0.2.0';

const releaseBody = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/dkveil/nesvo/releases/tag/v0.2.0',
  published_at: '2026-11-20T10:00:00Z',
  assets: [
    {
      name: 'Nesvo-Windows-Setup.exe',
      size: 100,
      browser_download_url: `${DOWNLOAD}/Nesvo-Windows-Setup.exe`,
    },
    {
      name: 'Nesvo-macOS-arm64.dmg',
      size: 200,
      browser_download_url: `${DOWNLOAD}/Nesvo-macOS-arm64.dmg`,
    },
    {
      name: 'SHA256SUMS.txt',
      size: 10,
      browser_download_url: `${DOWNLOAD}/SHA256SUMS.txt`,
    },
  ],
};

const githubFetcher =
  (status = 200): Fetcher =>
  async input => {
    if (input.endsWith('/SHA256SUMS.txt')) {
      return new Response(
        `${WINDOWS_SUM}  Nesvo-Windows-Setup.exe\n${ARM_SUM}  Nesvo-macOS-arm64.dmg\n`,
      );
    }
    if (status !== 200) return new Response('{}', { status });
    return Response.json(releaseBody);
  };

const failingFetcher: Fetcher = async () => {
  throw new Error('offline');
};

let database: TestDatabase;

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.sqlite.close();
});

describe('fetchLatestRelease', () => {
  it('reads the version, stable assets and checksums', async () => {
    const state = await fetchLatestRelease(config, githubFetcher());

    expect(state.status).toBe('published');
    if (state.status !== 'published') return;
    expect(state.release.version).toBe('0.2.0');
    expect(state.release.downloads).toEqual([
      {
        target: 'windows',
        fileName: 'Nesvo-Windows-Setup.exe',
        sizeBytes: 100,
        sha256: WINDOWS_SUM,
        isPublished: true,
      },
      {
        target: 'mac',
        fileName: 'Nesvo-macOS-arm64.dmg',
        sizeBytes: 200,
        sha256: ARM_SUM,
        isPublished: true,
      },
      {
        target: 'mac-intel',
        fileName: 'Nesvo-macOS-x64.dmg',
        sizeBytes: null,
        sha256: null,
        isPublished: false,
      },
    ]);
  });

  it('reports no release when the repository has none', async () => {
    expect(await fetchLatestRelease(config, githubFetcher(404))).toEqual({
      status: 'none',
    });
  });

  it('reports the release as unavailable when the request fails', async () => {
    expect(await fetchLatestRelease(config, failingFetcher)).toEqual({
      status: 'unavailable',
    });
    expect(await fetchLatestRelease(config, githubFetcher(500))).toEqual({
      status: 'unavailable',
    });
  });

  it('parses checksum files with binary markers', () => {
    expect(parseChecksums(`${ARM_SUM} *Nesvo-macOS-arm64.dmg\nnoise`)).toEqual(
      new Map([['Nesvo-macOS-arm64.dmg', ARM_SUM]]),
    );
  });
});

describe('loadReleaseState', () => {
  it('serves the cached release and keeps it when the refresh fails', async () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const fresh = await loadReleaseState({
      db: database,
      config,
      now,
      fetcher: githubFetcher(),
    });
    const cached = await loadReleaseState({
      db: database,
      config,
      now: now + 1000,
      fetcher: failingFetcher,
    });
    const stale = await loadReleaseState({
      db: database,
      config,
      now: now + RELEASE_CACHE_TTL_MS + 1,
      fetcher: failingFetcher,
    });

    expect(fresh.status).toBe('published');
    expect(cached).toEqual(fresh);
    expect(stale).toEqual(fresh);
  });
});
