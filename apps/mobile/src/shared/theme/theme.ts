import { Platform } from 'react-native';

import tokens from '@nesvo/brand/tokens.json';

export const colors = {
  ...tokens.colors,
  // Compatibility names keep existing semantic warnings and informational UI stable.
  orange: tokens.colors.warning,
  blue: tokens.colors.info,
};
export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  web: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  default: 'monospace',
});
