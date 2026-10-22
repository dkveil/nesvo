import { StyleSheet, Text, View } from 'react-native';

import {
  attemptsLabel,
  formatInstant,
  JOB_OCCURRENCE_STATE_LABELS,
  type JobTone,
  occurrenceTone,
  triggerLabel,
} from '@entities/job';

import type { JobOccurrence, JobRetryPolicy } from '@shared/api/host';
import { colors, mono } from '@shared/theme';
import { Pill } from '@shared/ui';

const TONE_COLORS = {
  success: colors.success,
  danger: colors.danger,
  warning: colors.warning,
  muted: colors.muted,
} as const satisfies Record<JobTone, string>;

type OccurrenceRowProps = { occurrence: JobOccurrence; policy: JobRetryPolicy | undefined };

export const OccurrenceRow = ({ occurrence, policy }: OccurrenceRowProps) => {
  const label = JOB_OCCURRENCE_STATE_LABELS[occurrence.state];
  const finished = occurrence.finishedAt ?? occurrence.startedAt;
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`Occurrence ${label}, due ${formatInstant(occurrence.dueAt)}`}
    >
      <View style={styles.heading}>
        <Pill label={label} color={TONE_COLORS[occurrenceTone(occurrence.state)]} />
        <Text style={styles.trigger}>{triggerLabel(occurrence.trigger)}</Text>
      </View>
      <Text style={styles.meta}>Due {formatInstant(occurrence.dueAt)}</Text>
      {finished !== null ? (
        <Text style={styles.meta}>
          {occurrence.finishedAt !== null ? 'Finished' : 'Started'} {formatInstant(finished)}
        </Text>
      ) : null}
      <Text style={styles.meta}>{attemptsLabel(occurrence, policy)}</Text>
      {occurrence.reason ? <Text style={styles.reason}>{occurrence.reason}</Text> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    gap: 4,
    padding: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
  },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  trigger: { color: colors.muted, fontFamily: mono, fontSize: 11 },
  meta: { color: colors.faint, fontFamily: mono, fontSize: 11, lineHeight: 17 },
  reason: { color: colors.muted, fontFamily: mono, fontSize: 12 },
});
