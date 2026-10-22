import { useEffect, useState } from 'react';

import { RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';

import { INBOX_PRIORITY_LABELS, useInbox } from '@entities/inbox';
import { useWorkspace } from '@entities/workspace';

import type { InboxItem } from '@shared/api/host';
import { colors, mono } from '@shared/theme';
import { Button, common, FreshnessBadge, IconButton } from '@shared/ui';

import { InboxItemRow } from './inbox-item-row';

const CLOCK_TICK_MS = 30_000;

const PRIORITY_COLORS = { 3: colors.danger, 2: colors.warning, 1: colors.info } as const;

type InboxScreenProps = { onBack: () => void };

export const InboxScreen = ({ onBack }: InboxScreenProps) => {
  const { openSession, openDecision } = useWorkspace();
  const {
    supported,
    decisionsSupported,
    connected,
    sections,
    total,
    skipped,
    nextPage,
    receivedAt,
    loading,
    failed,
    notice,
    dismissNotice,
    refresh,
    loadMore,
    acknowledge,
  } = useInbox();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const openTarget = (item: InboxItem) => {
    const { sessionId, decisionId } = item;
    if (item.kind === 'session' && sessionId) return () => openSession(sessionId);
    if (item.kind === 'decision' && decisionId && decisionsSupported)
      return () => openDecision(decisionId);
    return null;
  };
  const listSections = sections.map(section => ({ ...section, data: section.items }));
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <IconButton name="chevron-back" label="Back" onPress={onBack} />
        <Text style={styles.title}>Inbox</Text>
        <Text style={styles.count}>{supported ? total : ''}</Text>
      </View>
      <SectionList
        sections={supported ? listSections : []}
        keyExtractor={item => `${item.id}@${item.revision}`}
        contentContainerStyle={styles.content}
        stickySectionHeadersEnabled={false}
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
            {supported && skipped > 0 ? (
              <Text style={common.body}>
                {skipped === 1
                  ? '1 item needs a newer nesvo app.'
                  : `${skipped} items need a newer nesvo app.`}
              </Text>
            ) : null}
            {notice ? (
              <View style={styles.notice} accessibilityLiveRegion="polite">
                <Text style={styles.noticeText}>{notice}</Text>
                <IconButton name="close" label="Dismiss message" onPress={dismissNotice} />
              </View>
            ) : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.section, { color: PRIORITY_COLORS[section.priority] }]}>
            {INBOX_PRIORITY_LABELS[section.priority]}
          </Text>
        )}
        renderItem={({ item }) => (
          <InboxItemRow
            item={item}
            now={now}
            canAcknowledge={connected}
            onOpen={openTarget(item)}
            onAcknowledge={() => acknowledge(item)}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <Text style={common.body}>
            {!supported
              ? 'This host does not offer an inbox. Update the nesvo host to collect sessions, decisions and job results here.'
              : receivedAt === null
                ? connected
                  ? 'Loading the inbox…'
                  : 'Connect to a host to see the inbox.'
                : failed
                  ? 'The inbox could not refresh. Pull down to try again.'
                  : 'Nothing needs you.'}
          </Text>
        }
        ListFooterComponent={
          supported && nextPage !== null ? (
            <Button
              secondary
              style={styles.more}
              label="Load more"
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
  intro: { gap: 10, marginBottom: 4 },
  section: {
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.2,
    marginTop: 16,
    marginBottom: 8,
  },
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
