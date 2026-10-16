export type Pairing = { version: 1; url: string; key: string };

export type TerminalSession = {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  cols: number;
  rows: number;
  running: boolean;
};

export type HostEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; reason: string }
  | { type: 'sessions'; sessions: TerminalSession[] }
  | { type: 'attached'; sessionId: string }
  | { type: 'output'; sessionId: string; data: string; replay?: boolean }
  | { type: 'error'; message: string };

export type ClientCommand =
  | { type: 'auth'; clientNonce: string }
  | { type: 'list' }
  | { type: 'create'; name: string; cwd?: string }
  | { type: 'attach'; sessionId: string; cols: number; rows: number }
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'close'; sessionId: string };

export type ServerMessage =
  | Exclude<HostEvent, { type: 'disconnected' | 'connected' }>
  | { type: 'connected'; clientNonce: string };
