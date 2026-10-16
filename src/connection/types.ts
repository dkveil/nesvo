export type Pairing = { version: 1; url: string; key: string };

export type SessionGroup = { id: string; parentId: string | null; name: string; order: number };
export type SessionControl = {
  sessionId: string;
  controllerId: number | null;
  leaseId?: string;
  cols: number;
  rows: number;
};

export type TerminalSession = {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  cols: number;
  rows: number;
  running: boolean;
  groupId: string | null;
  controllerId: number | null;
};

export type HostEvent =
  | { type: 'connected'; clientId: number; protocolVersion: 2 }
  | { type: 'disconnected'; reason: string }
  | { type: 'sessions'; sessions: TerminalSession[]; groups: SessionGroup[]; revision: number }
  | { type: 'created'; sessionId: string; requestId?: string }
  | { type: 'groupCreated'; groupId: string; revision: number; requestId?: string }
  | { type: 'updated'; revision: number; requestId?: string }
  | { type: 'subscribed'; sessionId: string; cols: number; rows: number }
  | { type: 'unsubscribed'; sessionId: string }
  | ({ type: 'control' } & SessionControl)
  | { type: 'attached'; sessionId: string }
  | { type: 'output'; sessionId: string; data: string; replay?: boolean; allowResponses?: boolean }
  | { type: 'error'; message: string; requestId?: string; code?: string; revision?: number };

export type ClientCommand =
  | { type: 'auth'; clientNonce: string }
  | { type: 'list' }
  | { type: 'create'; name: string; cwd?: string; groupId: string | null; requestId: string }
  | {
      type: 'createGroup';
      name: string;
      parentId: string | null;
      expectedRevision: number;
      requestId?: string;
    }
  | {
      type: 'updateGroup';
      groupId: string;
      name: string;
      parentId: string | null;
      order: number;
      expectedRevision: number;
      requestId?: string;
    }
  | { type: 'deleteGroup'; groupId: string; expectedRevision: number; requestId?: string }
  | {
      type: 'moveSession';
      sessionId: string;
      groupId: string | null;
      expectedRevision: number;
      requestId?: string;
    }
  | { type: 'subscribe' | 'unsubscribe'; sessionId: string }
  | { type: 'acquireControl'; sessionId: string; cols: number; rows: number; takeOver: boolean }
  | { type: 'releaseControl'; sessionId: string; leaseId: string }
  | { type: 'attach'; sessionId: string; cols: number; rows: number }
  | { type: 'input'; sessionId: string; data: string; leaseId: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number; leaseId: string }
  | { type: 'close'; sessionId: string };

export type ServerMessage =
  | Exclude<HostEvent, { type: 'disconnected' | 'connected' }>
  | { type: 'connected'; clientNonce: string; clientId: number; protocolVersion: 2 };
