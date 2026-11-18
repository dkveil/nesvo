import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DesktopSession, SubsessionEntry } from '@nesvo/contracts';
import { colors } from '@/components/ui';
import { useNow } from '@/hooks/use-now';
import { formatElapsed } from '@/utils/elapsed';

type AgentsSheetProps = {
  visible: boolean;
  entries: SubsessionEntry<DesktopSession>[];
  isStopDisabled: (session: DesktopSession) => boolean;
  onClose: () => void;
  onOpen: (session: DesktopSession) => void;
  onStop: (session: DesktopSession) => void;
};

type AgentRowProps = {
  entry: SubsessionEntry<DesktopSession>;
  now: number;
  stopDisabled: boolean;
  onOpen: () => void;
  onStop: () => void;
};

const ELAPSED_TICK_MS = 1000;

const statusLabels: Record<DesktopSession['status'], string> = {
  ready: 'Ready',
  running: 'Working',
  stopping: 'Stopping…',
  completed: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const needsApproval = (session: DesktopSession) =>
  session.status === 'running' &&
  (session.pendingApprovals.length > 0 ||
    session.delegations.some(
      delegation =>
        delegation.runId === session.runId && delegation.status === 'pending',
    ));

const stateColor = (session: DesktopSession) => {
  if (needsApproval(session)) return colors.warning;
  if (session.status === 'running' || session.status === 'stopping')
    return colors.info;
  if (session.status === 'completed') return colors.success;
  if (session.status === 'failed') return colors.error;
  return colors.muted;
};

const locationOf = (session: DesktopSession) =>
  session.worktree?.branch ??
  session.directory.split(/[\\/]/).filter(Boolean).at(-1) ??
  session.directory;

function AgentRow({ entry, now, stopDisabled, onOpen, onStop }: AgentRowProps) {
  const { session, active, startedAt, finishedAt } = entry;
  const state = needsApproval(session)
    ? 'Needs approval'
    : statusLabels[session.status];
  const elapsed = formatElapsed(startedAt, finishedAt, now);
  const model = session.actualModel ?? session.model;
  const location = locationOf(session);
  const color = stateColor(session);
  return (
    <View
      style={[styles.row, !active && styles.finished]}
      testID={`agent-row-${session.id}`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${session.title}, ${state}${elapsed ? `, ${elapsed}` : ''}, ${session.provider} ${model}, ${location}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        testID={`agent-open-${session.id}`}
      >
        <View style={[styles.dot, { backgroundColor: color }]} />
        <View style={styles.text}>
          <View style={styles.line}>
            <Text numberOfLines={1} style={styles.title}>
              {session.title}
            </Text>
            <Text style={[styles.meta, { color }]}>{state}</Text>
            {!!elapsed && <Text style={styles.meta}>{elapsed}</Text>}
          </View>
          <Text numberOfLines={1} style={styles.detail}>
            {session.provider} · {model} · {location}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>
      {active && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Stop ${session.title}`}
          accessibilityState={{ disabled: stopDisabled }}
          disabled={stopDisabled}
          onPress={onStop}
          style={({ pressed }) => [
            styles.stop,
            pressed && styles.stopPressed,
            stopDisabled && styles.disabled,
          ]}
          testID={`agent-stop-${session.id}`}
        >
          <View style={styles.stopGlyph} />
        </Pressable>
      )}
    </View>
  );
}

export function AgentsSheet({
  visible,
  entries,
  isStopDisabled,
  onClose,
  onOpen,
  onStop,
}: AgentsSheetProps) {
  const insets = useSafeAreaInsets();
  const now = useNow(ELAPSED_TICK_MS, visible);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <Pressable
          accessibilityLabel="Close agents"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <View
          accessibilityViewIsModal
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
          testID="agents-sheet"
        >
          <View style={styles.handle} />
          <View style={styles.header}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}
              testID="agents-close"
            >
              <Text style={styles.closeText}>×</Text>
            </Pressable>
            <Text accessibilityRole="header" style={styles.heading}>
              Agents
            </Text>
            <View style={styles.close} />
          </View>
          <ScrollView>
            {entries.map(entry => (
              <AgentRow
                key={entry.session.id}
                entry={entry}
                now={now}
                stopDisabled={isStopDisabled(entry.session)}
                onOpen={() => onOpen(entry.session)}
                onStop={() => onStop(entry.session)}
              />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: colors.overlay,
  },
  sheet: {
    maxHeight: '70%',
    backgroundColor: colors.panel,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  heading: { color: colors.text, fontSize: 17, fontWeight: '600' },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: colors.text, fontSize: 26, lineHeight: 28 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  finished: { opacity: 0.6 },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderRadius: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { flex: 1, gap: 3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { flexShrink: 1, color: colors.text, fontSize: 15 },
  meta: {
    color: colors.muted,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  detail: { color: colors.muted, fontSize: 13 },
  chevron: { color: colors.muted, fontSize: 20 },
  stop: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dangerSurface,
  },
  stopPressed: { opacity: 0.7 },
  stopGlyph: {
    width: 14,
    height: 14,
    borderRadius: 3,
    backgroundColor: colors.danger,
  },
  pressed: { backgroundColor: colors.border },
  disabled: { opacity: 0.5 },
});
