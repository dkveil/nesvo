import { Platform } from 'react-native';

export const colors = {
  background: '#0B0B0B',
  surface: '#191919',
  elevated: '#242424',
  border: '#303030',
  text: '#F4F4F4',
  muted: '#A1A1A1',
  faint: '#8A8A8A',
  accent: '#F4F4F4',
  accentInk: '#111111',
  orange: '#C6AE8B',
  blue: '#A6B4C4',
  danger: '#E0A4A4',
};
export const mono = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });
