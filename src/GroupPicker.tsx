import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './components';
import type { SessionGroup } from './connection/types';
import { flattenGroups } from './groups';
import { colors as c } from './theme';

/** A compact, scroll-container-friendly tree shared by create and move forms. */
export function GroupPicker({
  groups,
  value,
  onChange,
  disabled,
  excluded,
  rootLabel = 'Bez grupy',
}: {
  groups: SessionGroup[];
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  excluded?: Set<string>;
  rootLabel?: string;
}) {
  return (
    <View style={s.list}>
      {[
        { id: null, name: rootLabel, depth: 0 },
        ...flattenGroups(groups).filter((group) => !excluded?.has(group.id)),
      ].map((group) => (
        <Pressable
          key={group.id ?? 'root'}
          accessibilityRole="radio"
          accessibilityLabel={`Grupa: ${group.name}`}
          accessibilityState={{ checked: value === group.id, disabled }}
          disabled={disabled}
          onPress={() => onChange(group.id)}
          style={({ pressed }) => [
            s.row,
            { paddingLeft: 12 + Math.min(group.depth, 5) * 14 },
            value === group.id && s.selected,
            pressed && s.pressed,
          ]}
        >
          <Icon name={group.id ? 'folder-outline' : 'albums-outline'} size={18} />
          <Text style={s.name} numberOfLines={2}>
            {group.name}
          </Text>
          {value === group.id && <Icon name="checkmark" color={c.text} size={18} />}
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  list: { gap: 3 },
  row: {
    minHeight: 44,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    paddingVertical: 10,
    paddingRight: 12,
    borderRadius: 12,
  },
  name: { color: c.text, fontSize: 14, flex: 1 },
  selected: { backgroundColor: c.elevated },
  pressed: { opacity: 0.6 },
});
