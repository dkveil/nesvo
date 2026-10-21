import { StyleSheet, Text, View } from 'react-native';

import { Link, useIsFocused, useLocalSearchParams } from 'expo-router';

import { SessionScreen } from '@features/terminal-session';

import { useWorkspace } from '@entities/workspace';

import { colors } from '@shared/theme';
import { common } from '@shared/ui';

export default function SessionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isFocused = useIsFocused();
  const { sessions, client, connected, closeSession, returnToSessions } = useWorkspace();
  const session = sessions.find(item => item.id === id);

  // A stack retains previous routes. Only the visible terminal subscribes and
  // attaches, so returning from another route cannot leave a hidden controller.
  if (!isFocused) return null;
  if (!session) {
    return (
      <View style={styles.empty}>
        <Text style={common.heading}>Session unavailable</Text>
        <Text style={common.body}>
          Go back to the list and connect the right host. The session may have ended or is not saved
          in this preview.
        </Text>
        <Link href="/" replace style={styles.link}>
          Back to sessions
        </Link>
      </View>
    );
  }
  return (
    <SessionScreen
      key={session.id}
      session={session}
      client={client}
      connected={connected}
      onBack={returnToSessions}
      onClose={() => closeSession(session)}
    />
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, justifyContent: 'center', padding: 24, gap: 20 },
  link: { color: colors.accent, fontSize: 15, paddingVertical: 12 },
});
