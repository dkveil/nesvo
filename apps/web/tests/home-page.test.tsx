import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import robots from '@/app/robots';
import { siteMetadata } from '@/app/site-metadata';
import { HomeView } from '@/components/home/home-view';
import type { DetectedSystem } from '@/releases/detect-system';
import type { ReleaseState } from '@/releases/release-state';
import { buildSiteHeaders } from '@/server/security-headers';

const CHECKSUM = 'a'.repeat(64);

const PUBLISHED: ReleaseState = {
  status: 'published',
  secondaryPreview: null,
  release: {
    version: '0.2.0',
    tagName: 'v0.2.0',
    isPrerelease: false,
    publishedAt: '2026-11-20T10:00:00Z',
    notesUrl: 'https://github.com/dkveil/nesvo/releases/tag/v0.2.0',
    checksumsUrl:
      'https://github.com/dkveil/nesvo/releases/download/v0.2.0/SHA256SUMS.txt',
    downloads: [
      {
        target: 'windows',
        fileName: 'Nesvo-Windows-Setup.exe',
        sizeBytes: 104_857_600,
        sha256: CHECKSUM,
        isPublished: true,
      },
      {
        target: 'mac',
        fileName: 'Nesvo-macOS-arm64.dmg',
        sizeBytes: 120_000_000,
        sha256: CHECKSUM,
        isPublished: true,
      },
      {
        target: 'mac-intel',
        fileName: 'Nesvo-macOS-x64.dmg',
        sizeBytes: 125_000_000,
        sha256: CHECKSUM,
        isPublished: true,
      },
    ],
  },
};

const PREVIEW = {
  ...PUBLISHED.release,
  version: '0.0.1-alpha.1',
  tagName: 'v0.0.1-alpha.1',
  isPrerelease: true,
  notesUrl: 'https://github.com/dkveil/nesvo/releases/tag/v0.0.1-alpha.1',
};

const INSTALL_COMMAND = 'curl -fsSL https://nesvo.dev/install.sh | sh';

const renderHome = (
  system: DetectedSystem,
  release: ReleaseState = PUBLISHED,
) =>
  renderToStaticMarkup(
    <HomeView
      release={release}
      system={system}
      installCommand={INSTALL_COMMAND}
    />,
  );

const primaryHref = (html: string) =>
  /class="download-button" href="([^"]+)"/.exec(html)?.[1] ?? null;

describe('Home page', () => {
  it('puts the Windows installer first on Windows', () => {
    const html = renderHome({ os: 'windows', architecture: 'x86' });

    expect(primaryHref(html)).toBe('/download/windows');
    expect(html).toContain('Download for Windows');
    expect(html).toContain(
      'v0.2.0 · Latest · Windows 10 and 11 · x64 · 100.0 MB',
    );
    expect(html).not.toContain('Pre-release');
    expect(html).toContain('Other platforms');
    expect(html).toContain('Run anyway');
  });

  it('offers a pre-release with the same platform downloads', () => {
    const release: ReleaseState = { ...PUBLISHED, release: PREVIEW };
    const html = renderHome({ os: 'windows', architecture: 'x86' }, release);

    expect(primaryHref(html)).toBe('/download/windows');
    expect(html).toContain('v0.0.1-alpha.1 · Pre-release');
    expect(html).toContain('Early build for testing.');
    expect(html).toContain('href="/download/mac"');
    expect(html).toContain('href="/download/mac-intel"');
    expect(html).not.toContain('aria-disabled="true"');
  });

  it('keeps the stable primary and links to preview release notes when both exist', () => {
    const html = renderHome(
      { os: 'windows', architecture: 'x86' },
      { ...PUBLISHED, secondaryPreview: PREVIEW },
    );

    expect(primaryHref(html)).toBe('/download/windows');
    expect(html).toContain('v0.2.0 · Latest');
    expect(html).toContain('href="' + PREVIEW.notesUrl + '"');
    expect(html).toContain('Try 0.0.1-alpha.1 (pre-release)');
    expect(html).not.toContain('Early build for testing.');
  });

  it('shows the pre-release version above the installers on phones', () => {
    const html = renderHome(
      { os: 'mobile', architecture: 'arm' },
      { ...PUBLISHED, release: PREVIEW },
    );

    expect(html).toContain('v0.0.1-alpha.1 · Pre-release');
    expect(html).toContain('Early build for testing.');
    expect(html).toContain('href="/download/mac"');
  });

  it('puts the matching disk image and the Terminal command first on a Mac', () => {
    const arm = renderHome({ os: 'macos', architecture: 'arm' });
    const intel = renderHome({ os: 'macos', architecture: 'x86' });
    const unknown = renderHome({ os: 'macos', architecture: null });

    expect(primaryHref(arm)).toBe('/download/mac');
    expect(arm).toContain('v0.2.0 · Latest · Apple silicon · .dmg');
    expect(arm).toContain(INSTALL_COMMAND);
    expect(arm).toContain('Use the Terminal installer.');
    expect(arm).toContain('Open Nesvo once and click Done.');
    expect(arm).toContain(
      'choose Open Anyway next to Nesvo and confirm with your password.',
    );
    expect(arm).not.toContain('Control-click');
    expect(arm).not.toContain('macOS from Terminal');
    expect(arm).not.toContain('Intel Mac?');
    expect(primaryHref(intel)).toBe('/download/mac-intel');
    expect(intel).toContain('v0.2.0 · Latest · Intel · .dmg');
    expect(unknown).toContain('Intel Mac?');
  });

  it('lists every platform with Linux as not available on Linux', () => {
    const html = renderHome({ os: 'linux', architecture: 'x86' });

    expect(primaryHref(html)).toBeNull();
    expect(html).toContain('All platforms');
    expect(html).toContain('/download/windows');
    expect(html).toContain('/download/mac-intel');
    expect(html).toContain('Not available yet');
  });

  it('keeps the version and checksums of the release behind a disclosure', () => {
    const html = renderHome({ os: 'windows', architecture: 'x86' });

    expect(html).toContain('Checksums');
    expect(html).toContain('macOS from Terminal');
    expect(html).toContain(CHECKSUM);
    expect(html).toContain('SHA256SUMS.txt');
    expect(html).toContain('Nesvo-macOS-x64.dmg');
  });

  it('keeps an inactive download and one line before the first release', () => {
    const html = renderHome(
      { os: 'windows', architecture: 'x86' },
      {
        status: 'none',
      },
    );

    expect(primaryHref(html)).toBeNull();
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('Download for Windows');
    expect(html).toContain('The first build is on its way.');
    expect(html).not.toContain('Other platforms');
    expect(html).not.toContain('Checksums');
    expect(html).not.toContain(INSTALL_COMMAND);
  });

  it('offers the releases fallback when release details are unavailable', () => {
    const html = renderHome(
      { os: 'macos', architecture: 'arm' },
      {
        status: 'unavailable',
      },
    );

    expect(primaryHref(html)).toBe('/download/mac');
    expect(html).toContain('Release details cannot be loaded');
    expect(html).not.toContain(INSTALL_COMMAND);
  });
});

describe('Indexing', () => {
  it('asks robots not to index or follow any page', () => {
    expect(siteMetadata.robots).toEqual({ index: false, follow: false });
    expect(robots()).toEqual({ rules: { userAgent: '*', disallow: '/' } });
    expect(robots()).not.toHaveProperty('sitemap');
  });

  it('sends the robots header in development and production', () => {
    for (const isProduction of [false, true]) {
      expect(buildSiteHeaders(isProduction)).toContainEqual({
        key: 'X-Robots-Tag',
        value: 'noindex, nofollow',
      });
    }
  });
});
