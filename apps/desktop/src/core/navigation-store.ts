import { atom } from 'nanostores';

export type Screen = 'sessions' | 'settings';

export const $screen = atom<Screen>('sessions');
