import type { DownloadTargetId } from './download-targets';

export const OPERATING_SYSTEMS = [
  'windows',
  'macos',
  'linux',
  'mobile',
  'unknown',
] as const;

export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];
export type Architecture = 'arm' | 'x86' | null;

export type DetectedSystem = {
  os: OperatingSystem;
  architecture: Architecture;
};

export type SystemHints = {
  platform?: string | null;
  architecture?: string | null;
  isMobile?: string | boolean | null;
  userAgent?: string | null;
  maxTouchPoints?: number | null;
};

export type PrimaryDownload = {
  target: DownloadTargetId | null;
  isArchitectureKnown: boolean;
};

const unquote = (value: string | null | undefined): string =>
  (value ?? '').trim().replace(/^"|"$/g, '').toLowerCase();

const osFromPlatformHint = (platform: string): OperatingSystem | null => {
  if (!platform) return null;
  if (platform === 'windows') return 'windows';
  if (platform === 'macos') return 'macos';
  if (platform === 'linux' || platform === 'chrome os') return 'linux';
  if (platform === 'android' || platform === 'ios') return 'mobile';
  return 'unknown';
};

const osFromUserAgent = (
  userAgent: string,
  maxTouchPoints: number,
): OperatingSystem => {
  if (/android|iphone|ipad|ipod|mobile/.test(userAgent)) return 'mobile';
  if (/windows nt|win64|win32/.test(userAgent)) return 'windows';
  if (/macintosh|mac os x/.test(userAgent)) {
    return maxTouchPoints > 1 ? 'mobile' : 'macos';
  }
  if (/cros|linux|x11/.test(userAgent)) return 'linux';
  return 'unknown';
};

const architectureFromHint = (architecture: string): Architecture => {
  if (architecture.startsWith('arm')) return 'arm';
  if (architecture === 'x86' || architecture === 'x64') return 'x86';
  return null;
};

const architectureFromUserAgent = (userAgent: string): Architecture => {
  if (/\b(?:arm64|aarch64)\b/.test(userAgent)) return 'arm';
  if (/\b(?:x86_64|x64|win64|wow64|amd64)\b/.test(userAgent)) return 'x86';
  return null;
};

const isMobileHint = (value: SystemHints['isMobile']): boolean =>
  value === true || unquote(typeof value === 'string' ? value : '') === '?1';

export const detectSystem = ({
  platform,
  architecture,
  isMobile,
  userAgent,
  maxTouchPoints,
}: SystemHints): DetectedSystem => {
  const agent = (userAgent ?? '').toLowerCase();
  const hintedOs = osFromPlatformHint(unquote(platform));
  const os = isMobileHint(isMobile)
    ? 'mobile'
    : (hintedOs ?? osFromUserAgent(agent, maxTouchPoints ?? 0));
  const hintedArchitecture = architectureFromHint(unquote(architecture));
  return {
    os,
    architecture:
      hintedArchitecture ??
      (os === 'macos' ? null : architectureFromUserAgent(agent)),
  };
};

export const resolvePrimaryDownload = ({
  os,
  architecture,
}: DetectedSystem): PrimaryDownload => {
  if (os === 'windows') return { target: 'windows', isArchitectureKnown: true };
  if (os !== 'macos') return { target: null, isArchitectureKnown: false };
  if (architecture === 'x86') {
    return { target: 'mac-intel', isArchitectureKnown: true };
  }
  return { target: 'mac', isArchitectureKnown: architecture === 'arm' };
};

export const readSystemHints = (headers: Headers): SystemHints => ({
  platform: headers.get('sec-ch-ua-platform'),
  architecture: headers.get('sec-ch-ua-arch'),
  isMobile: headers.get('sec-ch-ua-mobile'),
  userAgent: headers.get('user-agent'),
});
