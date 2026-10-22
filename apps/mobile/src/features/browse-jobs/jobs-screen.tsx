import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { useWorkspace } from '@entities/workspace';

import { colors, mono } from '@shared/theme';
import { Button, common, FreshnessBadge, IconButton } from '@shared/ui';

import { JobRow } from './job-row';
import { useJobList } from './use-job-list';

type JobsScreenProps = { active: boolean; onBack: () => void };

export const JobsScreen = ({ active, onBack }: JobsScreenProps) => {
  const { openJob } = useWorkspace();
  const {
    supported,
    connected,
    jobs,
    nextPage,
    receivedAt,
    loading,
    notice,
    dismissNotice,
    refresh,
    loadMore,
  } = useJobList(active);
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <IconButton name="chevron-back" label="Back" onPress={onBack} />
        <Text style={styles.title}>Jobs</Text>
        <Text style={styles.count}>{supported && receivedAt !== null ? jobs.length : ''}</Text>
      </View>
      <FlatList
        data={supported ? jobs : []}
        keyExtractor={job => job.id}
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
        ListHeaderComponent={
          <View style={styles.intro}>
            <FreshnessBadge receivedAt={receivedAt} connected={connected} />
            <Text style={common.body}>
              Jobs run on your computer without the app. This list is read-only; change jobs with
              the nesvo CLI or terminal app.
            </Text>
            {notice ? (
              <View style={styles.notice} accessibilityLiveRegion="polite">
                <Text style={styles.noticeText}>{notice}</Text>
                <IconButton name="close" label="Dismiss message" onPress={dismissNotice} />
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => <JobRow job={item} onOpen={() => openJob(item.id)} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <Text style={common.body}>
            {!supported
              ? 'This host does not offer jobs. Update the nesvo host to see scheduled jobs here.'
              : receivedAt === null
                ? connected
                  ? 'Loading jobs…'
                  : 'Connect to a host to see its jobs.'
                : 'No jobs on this host yet.'}
          </Text>
        }
        ListFooterComponent={
          supported && nextPage !== null ? (
            <Button
              secondary
              style={styles.more}
              label="Load more jobs"
              disabled={!connected || loading}
              onPress={loadMore}
            />
          ) : null
        }
      />
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
  count: { color: colors.muted, fontFamily: mono, fontSize: 13, marginRight: 12 },
  content: { padding: 16, paddingBottom: 28 },
  intro: { gap: 10, marginBottom: 16 },
  separator: { height: 8 },
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
  more: { marginTop: 16 },
});
