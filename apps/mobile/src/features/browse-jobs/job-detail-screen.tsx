import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  attemptsLabel,
  formatInstant,
  JOB_OCCURRENCE_STATE_LABELS,
  jobStateLabel,
  retryClassLabel,
  scheduleLabel,
} from '@entities/job';

import { colors, mono } from '@shared/theme';
import { Button, common, FreshnessBadge, IconButton } from '@shared/ui';

import { OccurrenceRow } from './occurrence-row';
import { useJobDetail } from './use-job-detail';

type JobDetailScreenProps = { jobId: string; active: boolean; onBack: () => void };

type FactProps = { label: string; value: string };

const Fact = ({ label, value }: FactProps) => (
  <View style={styles.fact}>
    <Text style={styles.factLabel}>{label}</Text>
    <Text style={styles.factValue}>{value}</Text>
  </View>
);

export const JobDetailScreen = ({ jobId, active, onBack }: JobDetailScreenProps) => {
  const {
    supported,
    connected,
    job,
    missing,
    occurrences,
    lastOccurrence,
    skipped,
    nextPage,
    receivedAt,
    loading,
    notice,
    dismissNotice,
    refresh,
    loadMore,
  } = useJobDetail(jobId, active);
  const policy = job?.spec.retry;
  const emptyText = !supported
    ? 'This host does not offer jobs.'
    : missing
      ? 'This job no longer exists on the host.'
      : connected
        ? 'Loading the job…'
        : 'Connect to a host to see this job.';
  return (
    <View style={styles.page} testID="job-detail">
      <View style={styles.header}>
        <IconButton name="chevron-back" label="Back to jobs" onPress={onBack} />
        <Text style={styles.title} numberOfLines={1}>
          {job?.title || 'Job'}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={refresh}
            enabled={supported ? connected : false}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
      >
        <FreshnessBadge receivedAt={receivedAt} connected={connected} />
        {notice ? (
          <View style={styles.notice} accessibilityLiveRegion="polite">
            <Text style={styles.noticeText}>{notice}</Text>
            <IconButton name="close" label="Dismiss message" onPress={dismissNotice} />
          </View>
        ) : null}
        {!job ? (
          <Text style={common.body}>{emptyText}</Text>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.section}>SCHEDULE</Text>
              <Fact label="When" value={scheduleLabel(job.schedule)} />
              <Fact label="State" value={jobStateLabel(job)} />
              {job.calendarError ? (
                <Fact label="Problem" value={job.calendarError.message} />
              ) : null}
              <Fact label="Agent" value={job.spec.profile.program ?? 'Unknown agent'} />
              <Fact label="Workspace" value={job.spec.profile.workspace} />
            </View>
            <View style={styles.card}>
              <Text style={styles.section}>LAST OCCURRENCE</Text>
              {lastOccurrence ? (
                <>
                  <Fact label="Outcome" value={JOB_OCCURRENCE_STATE_LABELS[lastOccurrence.state]} />
                  <Fact label="Due" value={formatInstant(lastOccurrence.dueAt)} />
                  <Fact label="Attempts" value={attemptsLabel(lastOccurrence, policy)} />
                  <Fact label="Retry class" value={retryClassLabel(lastOccurrence, policy)} />
                  {lastOccurrence.retry ? (
                    <Fact
                      label="Next retry"
                      value={formatInstant(lastOccurrence.retry.notBefore)}
                    />
                  ) : null}
                </>
              ) : (
                <Text style={common.body}>
                  {receivedAt === null ? 'Loading history…' : 'This job has not run yet.'}
                </Text>
              )}
              <Fact
                label="Retry policy"
                value={
                  policy
                    ? `Up to ${policy.maxAttempts} attempts on ${policy.on}`
                    : 'One attempt, no automatic retry'
                }
              />
            </View>
            <Text style={styles.section}>RECENT OCCURRENCES</Text>
            {skipped > 0 ? (
              <Text style={common.body}>
                {skipped === 1
                  ? '1 occurrence needs a newer nesvo app.'
                  : `${skipped} occurrences need a newer nesvo app.`}
              </Text>
            ) : null}
            {occurrences.map(occurrence => (
              <OccurrenceRow key={occurrence.id} occurrence={occurrence} policy={policy} />
            ))}
            {nextPage !== null ? (
              <Button
                secondary
                label="Load older occurrences"
                disabled={!connected || loading}
                onPress={loadMore}
              />
            ) : null}
            <View style={styles.card}>
              <Text style={styles.section}>INSTRUCTION</Text>
              <Text selectable style={styles.instruction}>
                {job.spec.instruction}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    minHeight: 54,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    flex: 1,
    color: colors.text,
    fontFamily: mono,
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 6,
  },
  content: { padding: 16, paddingBottom: 28, gap: 12 },
  card: { ...common.card, gap: 10 },
  section: {
    color: colors.muted,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.2,
  },
  fact: { gap: 2 },
  factLabel: { color: colors.faint, fontFamily: mono, fontSize: 11 },
  factValue: { color: colors.text, fontSize: 14, lineHeight: 20 },
  instruction: { color: colors.text, fontFamily: mono, fontSize: 12, lineHeight: 19 },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: 8,
    paddingLeft: 14,
    backgroundColor: colors.surface,
  },
  noticeText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 21, paddingVertical: 10 },
});
