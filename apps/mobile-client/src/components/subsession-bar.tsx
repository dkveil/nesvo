import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { colors } from '@/components/ui';

type SubsessionBarProps = {
  label: string;
  hasChildren: boolean;
  onOpen: () => void;
};

export function SubsessionBar({
  label,
  hasChildren,
  onOpen,
}: SubsessionBarProps) {
  return (
    <Pressable
      accessibilityRole={hasChildren ? 'button' : 'text'}
      accessibilityLabel={hasChildren ? `${label}, show agents` : label}
      accessibilityLiveRegion="polite"
      disabled={!hasChildren}
      onPress={onOpen}
      style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
      testID="subsession-bar"
    >
      <ActivityIndicator size="small" color={colors.info} />
      <Text numberOfLines={1} style={styles.text}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 4,
    borderRadius: 12,
  },
  text: {
    flexShrink: 1,
    color: colors.muted,
    fontSize: 14,
    fontVariant: ['tabular-nums'],
  },
  pressed: { opacity: 0.6 },
});
