import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors as c } from './theme';

export function Icon({
  name,
  color = c.muted,
  size = 20,
}: {
  name: React.ComponentProps<typeof Ionicons>['name'];
  color?: string;
  size?: number;
}) {
  return <Ionicons name={name} size={size} color={color} />;
}
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
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      {icon && <Icon name={icon} color={secondary ? c.text : c.accentInk} size={18} />}
      <Text style={[s.buttonText, secondary && { color: c.text }]}>{label}</Text>
    </Pressable>
  );
}
export function IconButton({
  name,
  label,
  onPress,
}: {
  name: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [s.iconButton, { opacity: pressed ? 0.5 : 1 }]}
    >
      <Icon name={name} color={c.text} size={22} />
    </Pressable>
  );
}
export function Pill({ label, color = c.accent }: { label: string; color?: string }) {
  return (
    <View style={[s.pill, { backgroundColor: `${color}13` }]}>
      <View style={[s.dot, { backgroundColor: color }]} />
      <Text style={[s.pillText, { color }]}>{label}</Text>
    </View>
  );
}
export const common = StyleSheet.create({
  input: {
    color: c.text,
    backgroundColor: c.background,
    borderColor: c.border,
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    fontSize: 16,
    minHeight: 48,
  },
  label: { color: c.muted, fontSize: 13, fontWeight: '500', marginBottom: 10 },
  body: { color: c.muted, fontSize: 15, lineHeight: 23 },
  heading: { color: c.text, fontSize: 26, fontWeight: '600', letterSpacing: -0.6 },
  card: {
    backgroundColor: c.surface,
    borderRadius: 20,
    padding: 20,
    gap: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
const s = StyleSheet.create({
  button: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 28,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  secondary: { backgroundColor: c.elevated },
  buttonText: { color: c.accentInk, fontSize: 15, fontWeight: '600' },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  pill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
  },
  pillText: { fontSize: 11, fontWeight: '600' },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
