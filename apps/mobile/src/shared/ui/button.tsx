import {
  Animated,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';

import { colors, mono } from '@shared/theme';

import { Icon, type IconName } from './icon';
import { usePressMotion } from './use-press-motion';

export function Button({
  label,
  onPress,
  secondary,
  disabled,
  icon,
  style,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const { scale, onPressIn, onPressOut } = usePressMotion();
  return (
    <Animated.View style={[style, { transform: [{ scale }] }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={({ pressed }) => [
          styles.button,
          secondary && styles.secondary,
          { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        ]}
      >
        {!!icon && (
          <Icon name={icon} color={secondary ? colors.text : colors.accentInk} size={18} />
        )}
        <Text style={[styles.text, secondary && { color: colors.text }]}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  secondary: { backgroundColor: colors.surface, borderColor: colors.border },
  text: { color: colors.accentInk, fontFamily: mono, fontSize: 13, fontWeight: '600' },
});
