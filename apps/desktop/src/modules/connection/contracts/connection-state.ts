export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type ConnectionState = {
  status: ConnectionStatus;
  message: string | null;
  attempt: number;
};

export type HostMode = 'local' | 'remote';

export type HostConfig = {
  mode: HostMode;
  hasRemotePairing: boolean;
  hostUrl: string | null;
  port: number;
  defaultPort: number;
  hostBinary: string | null;
};
