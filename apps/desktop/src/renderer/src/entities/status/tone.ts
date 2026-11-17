export type Tone = 'success' | 'error' | 'warning' | 'info' | 'muted';

export const toneText: Record<Tone, string> = {
  success: 'text-success-foreground',
  error: 'text-error-foreground',
  warning: 'text-warning-foreground',
  info: 'text-info-foreground',
  muted: 'text-muted-foreground',
};

export type StatusKind =
  'success' | 'error' | 'warning' | 'info' | 'pending' | 'running' | 'idle';

export const statusTones: Record<StatusKind, Tone> = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'info',
  pending: 'warning',
  running: 'info',
  idle: 'muted',
};
