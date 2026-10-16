import type { ComponentProps } from 'react';

import Ionicons from '@expo/vector-icons/Ionicons';

import { colors } from '@shared/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function Icon({
  name,
  color = colors.muted,
  size = 20,
}: {
  name: IconName;
  color?: string;
  size?: number;
}) {
  return <Ionicons name={name} size={size} color={color} />;
}
