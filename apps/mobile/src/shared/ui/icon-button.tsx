import { Animated, Pressable, StyleSheet } from 'react-native';

import { colors } from '@shared/theme';

import { Icon, type IconName } from './icon';
import { usePressMotion } from './use-press-motion';

export function IconButton({
  name,
  label,
  onPress,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
}) {
  const { scale, onPressIn, onPressOut } = usePressMotion();
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={({ pressed }) => [styles.button, { opacity: pressed ? 0.65 : 1 }]}
      >
        <Icon name={name} color={colors.text} size={22} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
});
