import { StyleSheet, Text, View } from 'react-native';

import { colors, mono } from '@shared/theme';

import type { SessionStatus, SessionStatusSource } from '../model/session';
import { sessionStatusDetail, sessionStatusLabel } from '../model/status-presentation';

const symbols: Record<SessionStatus, string> = {
  working: '›',
  idle: '·',
  done: '✓',
  blocked: '!',
  question: '?',
  failed: '×',
  unknown: '–',
};

export function SessionStatusBadge({
  status,
  source,
  demo = false,
}: {
  status: SessionStatus;
  source?: SessionStatusSource;
  demo?: boolean;
}) {
  const label = sessionStatusLabel(status, source);
  const tone =
    status === 'failed' || status === 'blocked'
      ? colors.danger
      : status === 'question'
        ? colors.orange
        : status === 'working' || status === 'done'
          ? colors.accent
          : colors.muted;
  return (
    <View
      accessibilityLabel={`${label}. ${demo ? 'Stan przykładowy' : sessionStatusDetail(status, source)}`}
      style={[styles.badge, { borderColor: `${tone}55` }]}
    >
      <Text style={[styles.symbol, { color: tone }]}>{symbols[status]}</Text>
      <Text style={[styles.label, { color: tone }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    minHeight: 23,
    alignSelf: 'flex-start',
  },
  symbol: { fontFamily: mono, fontSize: 12, fontWeight: '600' },
  label: { fontFamily: mono, fontSize: 10, lineHeight: 16, fontWeight: '500' },
});
