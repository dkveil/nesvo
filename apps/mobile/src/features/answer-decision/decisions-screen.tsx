import { useEffect, useState } from 'react';

import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { submissionKey } from '@entities/inbox';

import { colors, mono } from '@shared/theme';
import { Button, common, FreshnessBadge, IconButton } from '@shared/ui';

import { DecisionCard } from './decision-card';
import { usePendingDecisions } from './use-pending-decisions';

const CLOCK_TICK_MS = 15_000;

const NOTICE_COLORS = {
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
} as const;

type DecisionsScreenProps = { active: boolean; focusId?: string; onBack: () => void };

export const DecisionsScreen = ({ active, focusId, onBack }: DecisionsScreenProps) => {
  const insets = useSafeAreaInsets();
  const {
    supported,
    connected,
    decisions,
    total,
    nextPage,
    receivedAt,
    loading,
    submissions,
    notices,
    dismissNotice,
    refresh,
    loadMore,
    decide,
  } = usePendingDecisions(active);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const ordered = focusId
    ? [...decisions].sort(
        (left, right) => Number(right.id === focusId) - Number(left.id === focusId),
      )
    : decisions;
  const handleBack = () => {
    Keyboard.dismiss();
    onBack();
  };
  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <View style={styles.header}>
        <IconButton name="chevron-back" label="Back" onPress={handleBack} />
        <Text style={styles.title}>Decisions</Text>
        <Text style={styles.count}>{supported ? total : ''}</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
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
        {notices.map(notice => (
          <View
            key={notice.id}
            style={[styles.notice, { borderColor: NOTICE_COLORS[notice.tone] }]}
            accessibilityLiveRegion="polite"
          >
            <Text style={styles.noticeText}>{notice.text}</Text>
            <IconButton
              name="close"
              label="Dismiss message"
              onPress={() => dismissNotice(notice.id)}
            />
          </View>
        ))}
        {!supported ? (
          <Text style={common.body}>
            This host does not offer decisions. Update the nesvo host to answer agent questions from
            your phone.
          </Text>
        ) : decisions.length === 0 ? (
          <Text style={common.body}>
            {receivedAt === null
              ? connected
                ? 'Loading decisions…'
                : 'Connect to a host to see decisions.'
              : 'No decisions are waiting for you.'}
          </Text>
        ) : (
          ordered.map(decision => (
            <DecisionCard
              key={submissionKey(decision)}
              decision={decision}
              focused={decision.id === focusId}
              submission={submissions.get(submissionKey(decision))}
              connected={connected}
              now={now}
              onDecide={(choice, note) => decide(decision, choice, note)}
            />
          ))
        )}
        {supported && nextPage !== null ? (
          <Button
            secondary
            label="Load more decisions"
            disabled={!connected || loading}
            onPress={loadMore}
          />
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
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
  content: { padding: 16, gap: 12 },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingLeft: 14,
    backgroundColor: colors.surface,
  },
  noticeText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 21, paddingVertical: 10 },
});
