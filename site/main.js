const downloads = {
  windows: {
    href: 'https://github.com/dkveil/nesvo/releases/latest/download/Nesvo-Windows-Setup.exe',
    label: 'Download for Windows',
    detail: 'Windows 10 and 11, x64',
  },
  mac: {
    href: 'https://github.com/dkveil/nesvo/releases/latest/download/Nesvo-macOS-arm64.dmg',
    label: 'Download for macOS',
    detail: 'Apple silicon',
  },
  other: {
    href: 'https://github.com/dkveil/nesvo/releases',
    label: 'Download Nesvo',
    detail: 'Windows and macOS',
  },
};

const detectPlatform = () => {
  const reported = navigator.userAgentData?.platform ?? '';
  const agent = `${reported} ${navigator.userAgent}`.toLowerCase();
  if (/android|iphone|ipad|ipod/.test(agent)) return 'other';
  if (/windows|win32|win64/.test(agent)) return 'windows';
  if (/mac/.test(agent) && navigator.maxTouchPoints < 2) return 'mac';
  return 'other';
};

const applyPlatform = platform => {
  const root = document.querySelector('[data-download]');
  if (!root) return;
  root.dataset.platform = platform;
  const target = downloads[platform];
  root.querySelector('[data-primary-download]').href = target.href;
  root.querySelector('[data-primary-label]').textContent = target.label;
  root.querySelector('[data-primary-detail]').textContent = target.detail;
};

applyPlatform(detectPlatform());
