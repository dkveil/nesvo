import type { Tone } from '@/entities/status';
import type { StatusDotTone } from '@/shared/ui/status-dot';

export const dotTones: Record<Tone, StatusDotTone> = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'info',
  muted: 'neutral',
};
