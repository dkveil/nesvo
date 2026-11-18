import type { Session, sessionControlToolDefinitions } from '@nesvo/contracts';

export type SessionControlCaller = { sessionId: string; runId: string };

export type SessionControlCall = {
  tool: string;
  input: unknown;
  callId: string;
};

export type SessionControlReply = { text: string; ok: boolean };

export type SessionControlHandler = (
  call: SessionControlCall,
  signal: AbortSignal,
) => Promise<SessionControlReply>;

export type SessionControlToolDefinition = ReturnType<
  typeof sessionControlToolDefinitions
>[number];

export type SessionControlTurn = {
  tools: SessionControlToolDefinition[];
  call: SessionControlHandler;
};

export type SessionControlBridge = {
  available: (session: Session) => boolean;
  call: (
    caller: SessionControlCaller,
    call: SessionControlCall,
    signal: AbortSignal,
  ) => Promise<SessionControlReply>;
};
