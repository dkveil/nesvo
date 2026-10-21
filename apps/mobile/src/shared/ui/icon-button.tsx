import { Animated, Pressable, StyleSheet, Text } from 'react-native';

import { colors, mono } from '@shared/theme';

import { Icon, type IconName } from './icon';
import { usePressMotion } from './use-press-motion';

export function IconButton({
  name,
  label,
  onPress,
  badge = 0,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
  badge?: number;
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
        {badge > 0 ? (
          <Text style={styles.badge} importantForAccessibility="no">
            {badge > 99 ? '99+' : badge}
          </Text>
        ) : null}
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
  badge: {
    position: 'absolute',
    top: 4,
    right: 2,
    minWidth: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    overflow: 'hidden',
    textAlign: 'center',
    backgroundColor: colors.accent,
    color: colors.accentInk,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 18,
  },
});
