import { Platform } from 'react-native';

export const colors = {
  background: '#0D100E',
  surface: '#161B18',
  elevated: '#232A25',
  border: '#343D37',
  text: '#E7EEE9',
  muted: '#A5B1A9',
  faint: '#8A998F',
  accent: '#A0C9AE',
  accentInk: '#13231A',
  orange: '#D5B17A',
  blue: '#A4B7C2',
  danger: '#D89992',
};
export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  web: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  default: 'monospace',
});
