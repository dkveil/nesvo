import { Pressable, StyleSheet } from 'react-native';

import { colors } from '@shared/theme';

import { Icon, type IconName } from './icon';

export function IconButton({
  name,
  label,
  onPress,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { opacity: pressed ? 0.5 : 1 }]}
    >
      <Icon name={name} color={colors.text} size={22} />
    </Pressable>
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
