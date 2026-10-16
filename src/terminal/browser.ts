import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import { TERMINAL_CHANNEL, type TerminalEvent } from './types';

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (data: string) => void };
  }
}

const container = document.getElementById('terminal');
if (!container) throw new Error('Missing terminal container');

function emit(message: TerminalEvent) {
  if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
  else if (window.parent !== window) window.parent.postMessage(message, '*');
}

const terminal = new Terminal({
  fontFamily: 'Menlo, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  lineHeight: 1.28,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 3000,
  allowProposedApi: false,
  screenReaderMode: true,
  overviewRuler: { width: 0 },
  theme: {
    background: '#0B0B0B',
    foreground: '#DEDEDE',
    cursor: '#F4F4F4',
    cursorAccent: '#0B0B0B',
    selectionBackground: '#414141',
    selectionInactiveBackground: '#303030',
    black: '#242424',
    red: '#f18181',
    green: '#88B089',
    yellow: '#e9cc8c',
    blue: '#8aafe2',
    magenta: '#c5a1dc',
    cyan: '#8bc9cb',
    white: '#DEDEDE',
    brightBlack: '#737373',
    brightRed: '#ff9c96',
    brightGreen: '#A4C6A5',
    brightYellow: '#f4dda9',
    brightBlue: '#a8c7ee',
    brightMagenta: '#dac0ed',
    brightCyan: '#abe0dd',
    brightWhite: '#F4F4F4',
  },
  // Programs can emit OSC 8 links. Links stay text; a terminal must never navigate.
  linkHandler: { activate() {} },
});
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(container);
terminal.textarea?.setAttribute('aria-label', 'Terminal sesji');
terminal.textarea?.setAttribute('autocapitalize', 'off');
terminal.textarea?.setAttribute('autocorrect', 'off');
terminal.textarea?.setAttribute('spellcheck', 'false');

terminal.onData((data) => emit({ channel: TERMINAL_CHANNEL, type: 'data', data }));
terminal.onResize(({ cols, rows }) =>
  emit({ channel: TERMINAL_CHANNEL, type: 'resize', cols, rows }),
);

let lastCommandId = 0;
function receive(event: MessageEvent) {
  // Native WebView sends on document (Android) or window (iOS). Browser preview
  // accepts messages only from its embedding window. IDs prevent bubbling duplicates.
  if (!window.ReactNativeWebView && event.source !== window.parent) return;
  let message;
  try {
    message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  } catch {
    return;
  }
  if (
    !message ||
    message.channel !== TERMINAL_CHANNEL ||
    !Number.isSafeInteger(message.id) ||
    message.id <= lastCommandId
  )
    return;
  if (
    message.type === 'write' &&
    typeof message.data === 'string' &&
    message.data.length <= 1_048_576
  ) {
    lastCommandId = message.id;
    const id = message.id;
    terminal.write(message.data, () => emit({ channel: TERMINAL_CHANNEL, type: 'written', id }));
  } else if (message.type === 'reset') {
    lastCommandId = message.id;
    // The bridge sends resets only after the previous write's completion ACK.
    terminal.reset();
  } else if (message.type === 'focus') {
    lastCommandId = message.id;
    terminal.focus();
  }
}
window.addEventListener('message', receive);
document.addEventListener('message', receive as EventListener);

let resizeFrame: number | null = null;
function scheduleFit() {
  if (resizeFrame !== null) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    if (container && container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
  });
}
new ResizeObserver(scheduleFit).observe(container);
window.addEventListener('resize', scheduleFit);
window.visualViewport?.addEventListener('resize', scheduleFit);
document.fonts.ready.then(scheduleFit);

// The user gesture is required to show the software keyboard on iOS.
container.addEventListener('click', (event) => {
  if ((event.target as Element | null)?.closest('a')) event.preventDefault();
  if (!terminal.hasSelection()) terminal.focus();
});
document.addEventListener(
  'click',
  (event) => {
    if ((event.target as Element | null)?.closest('a')) event.preventDefault();
  },
  true,
);

requestAnimationFrame(() => {
  fit.fit();
  emit({ channel: TERMINAL_CHANNEL, type: 'ready' });
  emit({ channel: TERMINAL_CHANNEL, type: 'resize', cols: terminal.cols, rows: terminal.rows });
});
