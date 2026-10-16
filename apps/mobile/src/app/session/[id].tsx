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
        <Text style={common.heading}>Sesja niedostępna</Text>
        <Text style={common.body}>
          Wróć do listy i połącz właściwy host. Sesja mogła zostać zakończona lub nie jest zapisana
          w tym podglądzie.
        </Text>
        <Link href="/" replace style={styles.link}>
          Wróć do sesji
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
