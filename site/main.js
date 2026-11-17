const DOWNLOAD_START_MS = 1500;
const MAGNET_X_PX = 6;
const MAGNET_Y_PX = 4;

const PLATFORMS = {
  windows: {
    href: '/download/windows',
    label: 'Download for Windows',
    detail: 'Windows 10 and 11 · x64',
    hiddenLinks: ['windows'],
    note: [
      'Windows may warn about an unsigned app. Choose ',
      'More info',
      ', then ',
      'Run anyway',
      '.',
    ],
  },
  mac: {
    href: '/download/mac',
    label: 'Download for macOS',
    detail: 'Apple silicon · .dmg',
    hiddenLinks: ['mac', 'mac-intel'],
    note: [
      'macOS blocks unsigned apps at first. ',
      'Right‑click',
      ' Nesvo in Applications and choose ',
      'Open',
      '.',
    ],
  },
  other: {
    href: '/releases',
    label: 'Download Nesvo',
    detail: 'Windows and macOS',
    hiddenLinks: ['other'],
    note: null,
  },
};

const STATE_TEXT = {
  downloading: { label: 'Starting download…', detail: 'From GitHub Releases' },
  started: { label: 'Download started', detail: 'Check your downloads folder' },
};

const detectPlatform = () => {
  const reported = navigator.userAgentData?.platform ?? '';
  const agent = `${reported} ${navigator.userAgent}`.toLowerCase();
  if (/android|iphone|ipad|ipod/.test(agent)) return 'other';
  if (/windows|win32|win64/.test(agent)) return 'windows';
  if (/mac/.test(agent) && navigator.maxTouchPoints < 2) return 'mac';
  return 'other';
};

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const swapText = (text, label, detail, nextText) => {
  label.textContent = nextText.label;
  detail.textContent = nextText.detail;
  text.classList.remove('is-swapping');
  void text.offsetWidth;
  text.classList.add('is-swapping');
};

const renderNote = (note, segments) => {
  const tag = document.createElement('span');
  tag.className = 'first-launch-tag';
  tag.textContent = 'First launch';
  const parts = segments.map((segment, index) => {
    if (index % 2 === 0) return document.createTextNode(segment);
    const strong = document.createElement('strong');
    strong.textContent = segment;
    return strong;
  });
  note.replaceChildren(tag, ...parts);
  note.toggleAttribute('data-visible', true);
};

const trackPointer = button => {
  const handleMove = event => {
    if (event.pointerType !== 'mouse') return;
    const rect = button.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    button.style.setProperty('--glow-x', `${x}px`);
    button.style.setProperty('--glow-y', `${y}px`);
    if (prefersReducedMotion()) return;
    const shiftX = (x / rect.width - 0.5) * 2 * MAGNET_X_PX;
    const shiftY = (y / rect.height - 0.5) * 2 * MAGNET_Y_PX;
    button.style.setProperty('--shift-x', `${shiftX.toFixed(2)}px`);
    button.style.setProperty('--shift-y', `${shiftY.toFixed(2)}px`);
  };
  const handleLeave = () => {
    button.style.setProperty('--shift-x', '0px');
    button.style.setProperty('--shift-y', '0px');
  };
  button.addEventListener('pointermove', handleMove);
  button.addEventListener('pointerleave', handleLeave);
};

const isPlainClick = event =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

const setup = () => {
  const root = document.querySelector('[data-download]');
  if (!root) return;
  const button = root.querySelector('[data-primary]');
  const text = button.querySelector('.download-text');
  const label = button.querySelector('[data-label]');
  const detail = button.querySelector('[data-detail]');
  const note = root.querySelector('[data-note]');
  const intel = root.querySelector('[data-intel]');
  const platform = detectPlatform();
  const target = PLATFORMS[platform];

  root.dataset.platform = platform;
  button.href = target.href;
  label.textContent = target.label;
  detail.textContent = target.detail;
  intel.hidden = platform !== 'mac';
  root.querySelectorAll('[data-platform-link]').forEach(link => {
    link.hidden = target.hiddenLinks.includes(link.dataset.platformLink);
  });

  trackPointer(button);

  let startTimer = 0;
  button.addEventListener('click', event => {
    if (!target.note || !isPlainClick(event)) return;
    window.clearTimeout(startTimer);
    button.dataset.state = 'downloading';
    swapText(text, label, detail, STATE_TEXT.downloading);
    startTimer = window.setTimeout(() => {
      button.dataset.state = 'started';
      swapText(text, label, detail, STATE_TEXT.started);
      renderNote(note, target.note);
    }, DOWNLOAD_START_MS);
  });
};

setup();
