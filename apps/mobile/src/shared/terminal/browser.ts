import { colors } from '@nesvo/brand/tokens.json';
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
    background: colors.background,
    foreground: colors.text,
    cursor: colors.accent,
    cursorAccent: colors.background,
    selectionBackground: colors.selection,
    selectionInactiveBackground: colors.elevated,
    black: '#242424',
    red: '#f18181',
    green: '#88B089',
    yellow: '#e9cc8c',
    blue: '#8aafe2',
    magenta: '#c5a1dc',
    cyan: '#8bc9cb',
    white: colors.text,
    brightBlack: '#737373',
    brightRed: '#ff9c96',
    brightGreen: '#A4C6A5',
    brightYellow: '#f4dda9',
    brightBlue: '#a8c7ee',
    brightMagenta: '#dac0ed',
    brightCyan: '#abe0dd',
    brightWhite: colors.text,
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

let readOnly = false;
let interactive = true;
terminal.attachCustomKeyEventHandler(() => interactive);
let suppressWriteResponses = false;
let previousWriteAllowedResponses = true;
let fixedSize: { cols: number; rows: number } | null = null;

terminal.onData(data => {
  // Focus changes between the embedded terminal and the app's composer are UI
  // navigation, not shell input. Keep query replies and typed escape keys intact.
  if (data === '\x1b[I' || data === '\x1b[O') return;
  if (!readOnly && !suppressWriteResponses) emit({ channel: TERMINAL_CHANNEL, type: 'data', data });
});

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
    message.data.length <= 1_048_576 &&
    typeof message.allowResponses === 'boolean'
  ) {
    lastCommandId = message.id;
    const id = message.id;
    suppressWriteResponses = !message.allowResponses;
    // CAN prevents an unfinished historical query from becoming an allowed
    // response when its final byte happens to arrive in the first live chunk.
    const prefix = message.allowResponses && !previousWriteAllowedResponses ? '\x18' : '';
    previousWriteAllowedResponses = message.allowResponses;
    terminal.write(prefix + message.data, () => {
      suppressWriteResponses = false;
      emit({ channel: TERMINAL_CHANNEL, type: 'written', id });
    });
  } else if (message.type === 'reset') {
    lastCommandId = message.id;
    // The bridge sends resets only after the previous write's completion ACK.
    terminal.reset();
  } else if (message.type === 'focus') {
    lastCommandId = message.id;
    if (!readOnly && interactive) terminal.focus();
  } else if (message.type === 'blur') {
    lastCommandId = message.id;
    terminal.blur();
  } else if (message.type === 'interaction' && typeof message.enabled === 'boolean') {
    lastCommandId = message.id;
    interactive = message.enabled;
    if (container) container.inert = !interactive;
    if (terminal.textarea) terminal.textarea.disabled = !interactive;
    if (!interactive) terminal.blur();
  } else if (
    message.type === 'configure' &&
    typeof message.readOnly === 'boolean' &&
    ((message.cols === undefined && message.rows === undefined) ||
      (Number.isInteger(message.cols) &&
        message.cols >= 10 &&
        message.cols <= 300 &&
        Number.isInteger(message.rows) &&
        message.rows >= 2 &&
        message.rows <= 150))
  ) {
    lastCommandId = message.id;
    readOnly = message.readOnly;
    terminal.options.disableStdin = readOnly;
    terminal.options.cursorBlink = !readOnly;
    if (readOnly) terminal.blur();
    fixedSize = message.cols === undefined ? null : { cols: message.cols, rows: message.rows };
    applyViewport();
  }
}
window.addEventListener('message', receive);
document.addEventListener('message', receive as EventListener);

let resizeFrame: number | null = null;
let localSize = '';
function applyViewport() {
  if (!container || !container.clientWidth || !container.clientHeight) return;
  // Report the local available grid separately from the canonical host grid.
  const local = fit.proposeDimensions();
  if (local && `${local.cols}:${local.rows}` !== localSize) {
    localSize = `${local.cols}:${local.rows}`;
    emit({ channel: TERMINAL_CHANNEL, type: 'resize', ...local });
  }
  const element = terminal.element;
  if (!element) return;
  element.style.transform = '';
  element.style.width = '';
  element.style.height = '';
  if (fixedSize) {
    terminal.resize(fixedSize.cols, fixedSize.rows);
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    if (screen) {
      const width = screen.offsetWidth + 3;
      const height = screen.offsetHeight;
      const scale = Math.min(1, container.clientWidth / width, container.clientHeight / height);
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      element.style.transformOrigin = 'top left';
      element.style.transform = `scale(${scale})`;
    }
  } else fit.fit();
}
function scheduleFit() {
  if (resizeFrame !== null) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    applyViewport();
  });
}
new ResizeObserver(scheduleFit).observe(container);
window.addEventListener('resize', scheduleFit);
window.visualViewport?.addEventListener('resize', scheduleFit);
document.fonts.ready.then(scheduleFit);

// The user gesture is required to show the software keyboard on iOS.
container.addEventListener('click', event => {
  if ((event.target as Element | null)?.closest('a')) event.preventDefault();
  if (!readOnly && interactive && !terminal.hasSelection()) terminal.focus();
});
document.addEventListener(
  'click',
  event => {
    if ((event.target as Element | null)?.closest('a')) event.preventDefault();
  },
  true,
);

requestAnimationFrame(() => {
  fit.fit();
  emit({ channel: TERMINAL_CHANNEL, type: 'ready' });
  emit({ channel: TERMINAL_CHANNEL, type: 'resize', cols: terminal.cols, rows: terminal.rows });
});
