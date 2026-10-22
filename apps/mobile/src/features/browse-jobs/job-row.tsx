import { Pressable, StyleSheet, Text, View } from 'react-native';

import { jobStateLabel, scheduleLabel } from '@entities/job';

import type { JobSummary } from '@shared/api/host';
import { colors, mono } from '@shared/theme';
import { Icon } from '@shared/ui';

type JobRowProps = { job: JobSummary; onOpen: () => void };

export const JobRow = ({ job, onOpen }: JobRowProps) => {
  const title = job.title || 'Untitled job';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open job ${title}`}
      accessibilityHint="Shows the schedule and recent occurrences"
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View
        style={[styles.marker, { backgroundColor: job.enabled ? colors.success : colors.faint }]}
      />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.schedule} numberOfLines={2}>
          {scheduleLabel(job.schedule)}
        </Text>
        <Text style={styles.meta}>{jobStateLabel(job)}</Text>
      </View>
      <Icon name="chevron-forward" size={16} />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  pressed: { backgroundColor: colors.elevated },
  marker: { width: 8, height: 8, borderRadius: 4 },
  text: { flex: 1, minWidth: 0, gap: 3 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  schedule: { color: colors.muted, fontFamily: mono, fontSize: 12, lineHeight: 18 },
  meta: { color: colors.faint, fontFamily: mono, fontSize: 11 },
});
