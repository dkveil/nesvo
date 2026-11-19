import type {
  Session,
  SessionStageRecord,
  sessionControlToolDefinitions,
  stageToolDefinitions,
} from '@nesvo/contracts';

export type LiveSteerOutcome =
  | { status: 'steered'; deliveredAt: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'busy' | 'stale-run' | 'delivery-unknown' };

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

export type SessionControlToolDefinition =
  | ReturnType<typeof sessionControlToolDefinitions>[number]
  | ReturnType<typeof stageToolDefinitions>[number];

export type SessionControlTurn = {
  tools: SessionControlToolDefinition[];
  call: SessionControlHandler;
};

export type SessionControlBridge = {
  stopped?: (sessionId: string) => void;
  captureTerminal?: (session: Session) => void;
  captureQuestion?: (session: Session, record: SessionStageRecord) => void;
  available: (session: Session) => boolean;
  call: (
    caller: SessionControlCaller,
    call: SessionControlCall,
    signal: AbortSignal,
  ) => Promise<SessionControlReply>;
};
