import { StyleSheet, Text, View } from 'react-native';

import { colors } from '@shared/theme';

export function Pill({ label, color = colors.accent }: { label: string; color?: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: `${color}13` }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.text, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
  },
  text: { fontSize: 11, fontWeight: '600' },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
