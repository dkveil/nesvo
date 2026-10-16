import type { DemoSession } from './demo';

/** Presentation metadata derived from a host snapshot, or explicit demo data. */
export type Session = DemoSession & {
  live?: boolean;
  running?: boolean;
  controllerId?: number | null;
  cols?: number;
  rows?: number;
};
