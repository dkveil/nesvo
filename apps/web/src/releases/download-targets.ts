export const DOWNLOAD_TARGET_IDS = ['windows', 'mac', 'mac-intel'] as const;

export type DownloadTargetId = (typeof DOWNLOAD_TARGET_IDS)[number];

export type DownloadTarget = {
  fileName: string;
  title: string;
  buttonLabel: string;
  buttonDetail: string;
  detail: string;
  firstLaunch: string;
};

export const DOWNLOAD_TARGETS = {
  windows: {
    fileName: 'Nesvo-Windows-Setup.exe',
    title: 'Windows',
    buttonLabel: 'Download for Windows',
    buttonDetail: 'Windows 10 and 11 · x64',
    detail: 'Windows 10 and 11 · x64 installer',
    firstLaunch:
      'Windows may warn about an unsigned app. Choose More info, then Run anyway.',
  },
  mac: {
    fileName: 'Nesvo-macOS-arm64.dmg',
    title: 'macOS · Apple silicon',
    buttonLabel: 'Download for macOS',
    buttonDetail: 'Apple silicon · .dmg',
    detail: 'M1 or later · disk image',
    firstLaunch:
      'macOS blocks unsigned apps at first. Control-click Nesvo in Applications and choose Open.',
  },
  'mac-intel': {
    fileName: 'Nesvo-macOS-x64.dmg',
    title: 'macOS · Intel',
    buttonLabel: 'Download for macOS',
    buttonDetail: 'Intel · .dmg',
    detail: 'Intel processor · disk image',
    firstLaunch:
      'macOS blocks unsigned apps at first. Control-click Nesvo in Applications and choose Open.',
  },
} as const satisfies Record<DownloadTargetId, DownloadTarget>;

export const CHECKSUMS_FILE_NAME = 'SHA256SUMS.txt';

export const isDownloadTargetId = (value: string): value is DownloadTargetId =>
  (DOWNLOAD_TARGET_IDS as readonly string[]).includes(value);

export const repositoryUrl = (repository: string): string =>
  `https://github.com/${repository}`;

export const releasesUrl = (repository: string): string =>
  `${repositoryUrl(repository)}/releases`;

export const releaseAssetsUrl = (repository: string, tagName: string): string =>
  `${releasesUrl(repository)}/download/${encodeURIComponent(tagName)}`;
