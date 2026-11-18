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
  release: {
    version: '0.2.0',
    tagName: 'v0.2.0',
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
    expect(html).toContain('Windows 10 and 11 · x64 · v0.2.0');
    expect(html).toContain('More info, then Run anyway');
  });

  it('puts the matching disk image and the Terminal command first on a Mac', () => {
    const arm = renderHome({ os: 'macos', architecture: 'arm' });
    const intel = renderHome({ os: 'macos', architecture: 'x86' });
    const unknown = renderHome({ os: 'macos', architecture: null });

    expect(primaryHref(arm)).toBe('/download/mac');
    expect(arm).toContain('Apple silicon · .dmg · v0.2.0');
    expect(arm).toContain(INSTALL_COMMAND);
    expect(arm).toContain('Or install from Terminal');
    expect(arm).not.toContain('Get the Intel build');
    expect(primaryHref(intel)).toBe('/download/mac-intel');
    expect(intel).toContain('Intel · .dmg · v0.2.0');
    expect(unknown).toContain('Get the Intel build');
  });

  it('lists every platform with Linux as not available on Linux', () => {
    const html = renderHome({ os: 'linux', architecture: 'x86' });

    expect(primaryHref(html)).toBeNull();
    expect(html).toContain('All platforms');
    expect(html).toContain('/download/windows');
    expect(html).toContain('/download/mac-intel');
    expect(html).toContain('Not available yet');
  });

  it('shows the version and checksums of the release', () => {
    const html = renderHome({ os: 'windows', architecture: 'x86' });

    expect(html).toContain(CHECKSUM);
    expect(html).toContain('SHA256SUMS.txt');
    expect(html).toContain('Nesvo-macOS-x64.dmg');
  });

  it('explains that nothing is published before the first release', () => {
    const html = renderHome(
      { os: 'windows', architecture: 'x86' },
      {
        status: 'none',
      },
    );

    expect(primaryHref(html)).toBeNull();
    expect(html).toContain('Downloads coming soon');
    expect(html).toContain('No release is published yet');
    expect(html).toContain('All platforms');
    expect(html).toContain('>Windows<');
    expect(html).not.toContain(INSTALL_COMMAND);
  });

  it('keeps downloads working when release details are unavailable', () => {
    const html = renderHome(
      { os: 'macos', architecture: 'arm' },
      {
        status: 'unavailable',
      },
    );

    expect(primaryHref(html)).toBe('/download/mac');
    expect(html).toContain('Release details cannot be loaded');
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
