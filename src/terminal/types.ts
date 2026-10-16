export interface TerminalHandle {
  write(data: string, options?: { allowResponses?: boolean }): void;
  reset(): void;
  focus(): void;
  configure(options: TerminalViewport): void;
}

export type TerminalViewport = { readOnly: boolean; cols?: number; rows?: number };

export interface TerminalViewProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  initialOutput?: string;
  onReady?: () => void;
  readOnly?: boolean;
}

export const TERMINAL_CHANNEL = 'pocket-terminal';

export type TerminalCommand =
  | {
      channel: typeof TERMINAL_CHANNEL;
      id: number;
      type: 'write';
      data: string;
      allowResponses: boolean;
    }
  | ({ channel: typeof TERMINAL_CHANNEL; id: number; type: 'configure' } & TerminalViewport)
  | { channel: typeof TERMINAL_CHANNEL; id: number; type: 'reset' | 'focus' };

export type TerminalEvent =
  | { channel: typeof TERMINAL_CHANNEL; type: 'ready' }
  | { channel: typeof TERMINAL_CHANNEL; type: 'written'; id: number }
  | { channel: typeof TERMINAL_CHANNEL; type: 'data'; data: string }
  | { channel: typeof TERMINAL_CHANNEL; type: 'resize'; cols: number; rows: number };

/** Both WebView and iframe messages are untrusted until their shape is checked. */
export function parseTerminalEvent(value: unknown): TerminalEvent | null {
  try {
    const message = typeof value === 'string' ? JSON.parse(value) : value;
    if (!message || message.channel !== TERMINAL_CHANNEL) return null;
    if (message.type === 'ready') return message;
    if (message.type === 'written' && Number.isSafeInteger(message.id) && message.id > 0) {
      return message;
    }
    if (
      message.type === 'data' &&
      typeof message.data === 'string' &&
      message.data.length <= 1_048_576
    ) {
      return message;
    }
    if (
      message.type === 'resize' &&
      Number.isInteger(message.cols) &&
      message.cols >= 2 &&
      message.cols <= 1000 &&
      Number.isInteger(message.rows) &&
      message.rows >= 1 &&
      message.rows <= 1000
    ) {
      return message;
    }
    return null;
  } catch {
    return null;
  }
}
