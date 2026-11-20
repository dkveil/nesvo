import { z } from 'zod';

import type { SiteConfig } from '@/server/site-config';

import {
  CHECKSUMS_FILE_NAME,
  DOWNLOAD_TARGET_IDS,
  DOWNLOAD_TARGETS,
} from './download-targets';
import type { ReleaseDownload, ReleaseState } from './release-state';

const RELEASE_FETCH_TIMEOUT_MS = 5000;

const githubAssetSchema = z.object({
  name: z.string(),
  size: z.number(),
  browser_download_url: z.url(),
});

const githubReleaseSchema = z.object({
  tag_name: z.string().min(1),
  html_url: z.url(),
  published_at: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(githubAssetSchema),
});

const githubReleasesSchema = z.array(githubReleaseSchema);

type GithubAsset = z.infer<typeof githubAssetSchema>;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const parseChecksums = (text: string): Map<string, string> =>
  new Map(
    text
      .split(/\r?\n/)
      .map(line => /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim()))
      .filter(match => match !== null)
      .map(match => [match[2] ?? '', (match[1] ?? '').toLowerCase()]),
  );

const githubHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nesvo-web',
  'X-GitHub-Api-Version': '2022-11-28',
};

const fetchChecksums = async (
  asset: GithubAsset | undefined,
  fetcher: Fetcher,
): Promise<Map<string, string>> => {
  if (!asset) return new Map();
  try {
    const response = await fetcher(asset.browser_download_url, {
      headers: { 'User-Agent': 'nesvo-web' },
      signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
    });
    return response.ok ? parseChecksums(await response.text()) : new Map();
  } catch {
    return new Map();
  }
};

export const fetchLatestRelease = async (
  config: SiteConfig,
  fetcher: Fetcher = fetch,
): Promise<ReleaseState> => {
  try {
    const response = await fetcher(
      `${config.releaseApiOrigin}/repos/${config.releaseRepository}/releases?per_page=10`,
      {
        headers: githubHeaders,
        signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
      },
    );
    if (response.status === 404) return { status: 'none' };
    if (!response.ok) return { status: 'unavailable' };
    const parsed = githubReleasesSchema.safeParse(await response.json());
    if (!parsed.success) return { status: 'unavailable' };
    const [release] = parsed.data
      .filter(item => !item.draft)
      .sort((a, b) =>
        (b.published_at ?? '').localeCompare(a.published_at ?? ''),
      );
    if (!release) return { status: 'none' };
    const assets = new Map(release.assets.map(asset => [asset.name, asset]));
    const checksumsAsset = assets.get(CHECKSUMS_FILE_NAME);
    const checksums = await fetchChecksums(checksumsAsset, fetcher);
    const downloads: ReleaseDownload[] = DOWNLOAD_TARGET_IDS.map(target => {
      const { fileName } = DOWNLOAD_TARGETS[target];
      const asset = assets.get(fileName);
      return {
        target,
        fileName,
        sizeBytes: asset?.size ?? null,
        sha256: checksums.get(fileName) ?? null,
        isPublished: !!asset,
      };
    });
    return {
      status: 'published',
      release: {
        version: release.tag_name.replace(/^v/, ''),
        tagName: release.tag_name,
        isPrerelease: release.prerelease,
        publishedAt: release.published_at,
        notesUrl: release.html_url,
        checksumsUrl: checksumsAsset?.browser_download_url ?? null,
        downloads,
      },
    };
  } catch {
    return { status: 'unavailable' };
  }
};
