import { Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, mono } from '@shared/theme';
import { Icon } from '@shared/ui';

export const DASHBOARD_ITEMS = [
  { id: 'sessions', icon: 'terminal-outline', label: 'Sesje' },
  { id: 'hosts', icon: 'desktop-outline', label: 'Komputery' },
  { id: 'settings', icon: 'settings-outline', label: 'Ustawienia' },
] as const;

export type DashboardTab = (typeof DASHBOARD_ITEMS)[number]['id'];

export function DashboardNavigation({
  selected,
  onSelect,
}: {
  selected: DashboardTab;
  onSelect: (tab: DashboardTab) => void;
}) {
  return (
    <View accessibilityRole="tablist" accessibilityLabel="Nawigacja główna" style={s.bar}>
      {DASHBOARD_ITEMS.filter(item => item.id !== 'settings').map(item => (
        <Pressable
          key={item.id}
          accessibilityRole="tab"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: selected === item.id }}
          aria-selected={selected === item.id}
          onPress={() => {
            Keyboard.dismiss();
            onSelect(item.id);
          }}
          style={({ pressed }) => [
            s.item,
            selected === item.id && s.selected,
            pressed && s.pressed,
          ]}
        >
          <Icon
            name={item.icon}
            size={20}
            color={selected === item.id ? colors.accent : colors.muted}
          />
          <Text style={[s.label, selected === item.id && s.activeLabel]}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
  item: {
    flex: 1,
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderTopWidth: 2,
    borderTopColor: 'transparent',
  },
  selected: { borderTopColor: colors.accent },
  pressed: { backgroundColor: colors.surface },
  label: { color: colors.muted, fontFamily: mono, fontSize: 12 },
  activeLabel: { color: colors.text },
});
