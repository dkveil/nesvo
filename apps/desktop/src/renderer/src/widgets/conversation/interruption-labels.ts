import type { SessionInterruption } from '@nesvo/contracts';

export const interruptionLabels: Record<SessionInterruption['reason'], string> =
  {
    'host-shutdown': 'Interrupted when Nesvo closed',
    'host-restart': 'Recovered after the host stopped unexpectedly',
    'provider-disconnected': 'Agent connection ended unexpectedly',
  };
