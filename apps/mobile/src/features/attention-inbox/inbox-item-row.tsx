import { Pressable, StyleSheet, Text, View } from 'react-native';

import { INBOX_KIND_LABELS, inboxReasonLabel } from '@entities/inbox';

import type { InboxItem } from '@shared/api/host';
import { colors, mono } from '@shared/theme';
import { formatAge, Icon, type IconName } from '@shared/ui';

const KIND_ICONS = {
  session: 'terminal-outline',
  decision: 'help-circle-outline',
  run: 'git-network-outline',
  result: 'checkmark-done-outline',
} as const satisfies Record<InboxItem['kind'], IconName>;

type InboxItemRowProps = {
  item: InboxItem;
  now: number;
  canAcknowledge: boolean;
  onOpen: (() => void) | null;
  onAcknowledge: () => void;
};

export const InboxItemRow = ({
  item,
  now,
  canAcknowledge,
  onOpen,
  onAcknowledge,
}: InboxItemRowProps) => (
  <View style={styles.row}>
    <Pressable
      accessibilityRole={onOpen ? 'button' : undefined}
      accessibilityLabel={`${INBOX_KIND_LABELS[item.kind]}: ${item.title || inboxReasonLabel(item.reason)}`}
      accessibilityHint={onOpen ? 'Opens the related item' : undefined}
      disabled={!onOpen}
      onPress={onOpen ?? undefined}
      style={({ pressed }) => [styles.body, pressed && styles.pressed]}
    >
      <View style={styles.icon}>
        <Icon name={KIND_ICONS[item.kind]} color={colors.text} size={20} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={2}>
          {item.title || INBOX_KIND_LABELS[item.kind]}
        </Text>
        <Text style={styles.reason}>{inboxReasonLabel(item.reason)}</Text>
        {item.summary ? (
          <Text style={styles.summary} numberOfLines={3}>
            {item.summary}
          </Text>
        ) : null}
        <Text style={styles.meta}>
          {INBOX_KIND_LABELS[item.kind]}
          {item.program ? ` · ${item.program}` : ''}
          {item.at > 0 ? ` · ${formatAge(item.at, now)}` : ''}
        </Text>
      </View>
      {onOpen ? <Icon name="chevron-forward" size={16} /> : null}
    </Pressable>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Mark as reviewed"
      disabled={!canAcknowledge}
      onPress={onAcknowledge}
      hitSlop={6}
      style={({ pressed }) => [
        styles.acknowledge,
        pressed && styles.pressed,
        !canAcknowledge && styles.disabled,
      ]}
    >
      <Icon name="checkmark" color={colors.text} size={20} />
    </Pressable>
  </View>
);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    overflow: 'hidden',
  },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.elevated,
  },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  reason: { color: colors.muted, fontSize: 13 },
  summary: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  meta: { color: colors.faint, fontFamily: mono, fontSize: 11 },
  acknowledge: {
    width: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.border,
  },
  pressed: { backgroundColor: colors.elevated },
  disabled: { opacity: 0.4 },
});
