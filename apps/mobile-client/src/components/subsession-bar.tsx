import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/components/ui';

type SubsessionBarProps = {
  label: string;
  running: number;
  total: number;
  stopLabel: string;
  stopDisabled: boolean;
  onOpen: () => void;
  onStop: () => void;
};

export function SubsessionBar({
  label,
  running,
  total,
  stopLabel,
  stopDisabled,
  onOpen,
  onStop,
}: SubsessionBarProps) {
  const hasChildren = total > 0;
  return (
    <View style={styles.bar} testID="subsession-bar">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={hasChildren ? `${label}, show agents` : label}
        accessibilityState={{ disabled: !hasChildren }}
        disabled={!hasChildren}
        onPress={onOpen}
        style={({ pressed }) => [styles.label, pressed && styles.pressed]}
        testID="subsession-bar-open"
      >
        <Text numberOfLines={1} style={styles.text}>
          {label}
        </Text>
      </Pressable>
      <View style={styles.divider} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={stopLabel}
        accessibilityState={{ disabled: stopDisabled }}
        disabled={stopDisabled}
        onPress={onStop}
        style={({ pressed }) => [
          styles.segment,
          pressed && styles.pressed,
          stopDisabled && styles.disabled,
        ]}
        testID="subsession-bar-stop"
      >
        <Text style={styles.text}>Stop</Text>
      </Pressable>
      {hasChildren && (
        <>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${running} of ${total} workers running, show agents`}
            onPress={onOpen}
            style={({ pressed }) => [styles.segment, pressed && styles.pressed]}
            testID="subsession-bar-count"
          >
            <Text style={[styles.text, styles.count]}>
              {running}/{total}
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    backgroundColor: colors.panel,
    paddingHorizontal: 4,
  },
  label: {
    flex: 1,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  segment: {
    minHeight: 48,
    minWidth: 56,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  divider: { width: 1, height: 20, backgroundColor: colors.border },
  text: { color: colors.text, fontSize: 15 },
  count: { fontVariant: ['tabular-nums'] },
  pressed: { backgroundColor: colors.border },
  disabled: { opacity: 0.5 },
});
