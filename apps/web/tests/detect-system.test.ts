import { describe, expect, it } from 'bun:test';

import {
  detectSystem,
  readSystemHints,
  resolvePrimaryDownload,
} from '@/releases/detect-system';

const WINDOWS_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const MAC_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const LINUX_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const IPHONE_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

const primaryFor = (hints: Parameters<typeof detectSystem>[0]) =>
  resolvePrimaryDownload(detectSystem(hints));

describe('detectSystem', () => {
  it('uses client hints for macOS on Apple silicon', () => {
    expect(
      primaryFor({
        platform: '"macOS"',
        architecture: '"arm"',
        userAgent: MAC_AGENT,
      }),
    ).toEqual({ target: 'mac', isArchitectureKnown: true });
  });

  it('uses client hints for an Intel Mac', () => {
    expect(
      primaryFor({
        platform: '"macOS"',
        architecture: '"x86"',
        userAgent: MAC_AGENT,
      }),
    ).toEqual({ target: 'mac-intel', isArchitectureKnown: true });
  });

  it('defaults a Mac without architecture hints to Apple silicon and says so', () => {
    expect(primaryFor({ userAgent: MAC_AGENT })).toEqual({
      target: 'mac',
      isArchitectureKnown: false,
    });
  });

  it('falls back to the user agent for Windows and Linux', () => {
    expect(primaryFor({ userAgent: WINDOWS_AGENT }).target).toBe('windows');
    expect(detectSystem({ userAgent: LINUX_AGENT }).os).toBe('linux');
    expect(primaryFor({ userAgent: LINUX_AGENT }).target).toBeNull();
  });

  it('offers no primary download on phones and tablets', () => {
    expect(primaryFor({ userAgent: IPHONE_AGENT }).target).toBeNull();
    expect(
      primaryFor({ platform: '"Android"', isMobile: '?1', userAgent: '' })
        .target,
    ).toBeNull();
    expect(
      primaryFor({ userAgent: MAC_AGENT, maxTouchPoints: 5 }).target,
    ).toBeNull();
  });

  it('prefers the platform hint over the user agent string', () => {
    expect(
      primaryFor({ platform: '"Windows"', userAgent: MAC_AGENT }).target,
    ).toBe('windows');
  });

  it('reads client hints from request headers', () => {
    const headers = new Headers({
      'sec-ch-ua-platform': '"macOS"',
      'sec-ch-ua-arch': '"arm"',
      'user-agent': MAC_AGENT,
    });

    expect(detectSystem(readSystemHints(headers))).toEqual({
      os: 'macos',
      architecture: 'arm',
    });
  });
});
