import { useEffect, useState } from 'react';

import { StyleSheet, Text, View } from 'react-native';

import { colors, mono } from '@shared/theme';

import { formatAge } from './format-age';
import { Pill } from './pill';

const TICK_MS = 30_000;

type FreshnessBadgeProps = { receivedAt: number | null; connected: boolean };

export const FreshnessBadge = ({ receivedAt, connected }: FreshnessBadgeProps) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  if (receivedAt === null) return null;
  return (
    <View style={styles.row} accessibilityLiveRegion="polite">
      <Text style={styles.age}>Updated {formatAge(receivedAt, Math.max(now, receivedAt))}</Text>
      {connected ? null : <Pill label="Stale" color={colors.warning} />}
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  age: { color: colors.faint, fontFamily: mono, fontSize: 12 },
});
