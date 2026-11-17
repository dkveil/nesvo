import type { SessionMode } from '@nesvo/contracts';

export function cycleMode(modes: SessionMode[], current: SessionMode) {
  const index = modes.indexOf(current);
  return modes[(index + 1) % modes.length] ?? current;
}
