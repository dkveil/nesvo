import { atom, computed } from 'nanostores';

import type { SessionsSnapshot } from '../contracts/session-snapshot';
import { buildSessionRows } from './build-session-rows';

export const $snapshot = atom<SessionsSnapshot | null>(null);

export const $sessionRows = computed($snapshot, snapshot =>
  snapshot ? buildSessionRows(snapshot) : [],
);
