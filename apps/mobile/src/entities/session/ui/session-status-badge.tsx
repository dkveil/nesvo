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

function statusColor(status: SessionStatus) {
  if (status === 'failed' || status === 'blocked') return colors.danger;
  if (status === 'question') return colors.warning;
  if (status === 'working' || status === 'done') return colors.success;
  return colors.muted;
}

/** Decorative when paired with the row's explicit status label. */
export function SessionStatusDot({ status }: { status: SessionStatus }) {
  return <View aria-hidden style={[styles.dot, { backgroundColor: statusColor(status) }]} />;
}

export function SessionStatusBadge({
  status,
  source,
  demo = false,
  variant = 'badge',
}: {
  status: SessionStatus;
  source?: SessionStatusSource;
  demo?: boolean;
  variant?: 'badge' | 'plain';
}) {
  const label = sessionStatusLabel(status, source);
  const tone = statusColor(status);
  return (
    <View
      accessibilityLabel={`${label}. ${demo ? 'Stan przykładowy' : sessionStatusDetail(status, source)}`}
      style={variant === 'plain' ? styles.plain : [styles.badge, { borderColor: `${tone}55` }]}
    >
      {variant === 'badge' && (
        <Text style={[styles.symbol, { color: tone }]}>{symbols[status]}</Text>
      )}
      <Text style={[styles.label, { color: tone }]}>
        {source === 'screen' ? `~ ${label}` : label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4 },
  plain: { alignSelf: 'flex-start', paddingTop: 2 },
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
