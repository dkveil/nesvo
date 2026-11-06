export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export type ConnectionState = {
  status: ConnectionStatus;
  message: string | null;
  attempt: number;
};

export type HostConfig = {
  hasPairing: boolean;
  hostUrl: string | null;
  port: number;
  defaultPort: number;
};
