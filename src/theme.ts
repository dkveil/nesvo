import { Platform } from 'react-native';

export const colors = {
  background: '#101214',
  surface: '#1A1D20',
  elevated: '#23272B',
  border: '#2B3034',
  text: '#F3F4EF',
  muted: '#9DA5A9',
  faint: '#697378',
  accent: '#B9E69A',
  accentInk: '#17240E',
  orange: '#ECA57D',
  blue: '#9DBBDB',
  danger: '#F09C96',
};
export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
