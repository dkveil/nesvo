import { FlatList, Pressable, Text, View } from 'react-native';
import { router, useLocalSearchParams, Stack } from 'expo-router';
import { Action, Notice, styles } from '@/components/ui';
import { useMobileWorkspace } from '@/hooks/mobile-workspace';

export default function SessionsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const store = useMobileWorkspace();
  const computer = store.view?.computers.find(item => item.id === id);
  const sessions =
    store.view?.sessions
      .filter(session => session.hostId === id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [];
  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: computer?.name ?? 'Sessions' }} />
      <FlatList
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        data={sessions}
        keyExtractor={item => item.id}
        testID="sessions-list"
        ListHeaderComponent={
          !store.ready(id) ? (
            <View style={{ gap: 10 }}>
              <Notice>
                Offline snapshot. Work may still be running. Reconnect before
                sending messages or decisions.
              </Notice>
              <Action label="Reconnect" secondary onPress={store.reconnect} />
            </View>
          ) : (
            <Notice>
              Sessions run on {computer?.name ?? 'this computer'}. Open a saved
              conversation to continue.
            </Notice>
          )
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            accessibilityRole="button"
            accessibilityLabel={`Open session: ${item.title}`}
            testID={`session-${item.id}`}
            onPress={() =>
              router.push({
                pathname: '/session/[id]',
                params: { id: item.id, hostId: item.hostId },
              })
            }
          >
            <Text selectable style={styles.body}>
              {item.parentId ? '↳ ' : ''}
              {item.title}
            </Text>
            <Text style={styles.muted}>
              {item.provider} ·{' '}
              {item.parentId
                ? 'Worker · '
                : item.delegations.length > 0
                  ? 'Orchestrator · '
                  : ''}
              {item.status === 'running'
                ? 'Working'
                : item.status === 'stopping'
                  ? 'Stopping…'
                  : item.status === 'completed'
                    ? 'Done'
                    : item.status}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Notice>
            {store.status === 'connecting'
              ? 'Loading session history…'
              : 'No saved sessions on this computer. Start a session from the desktop.'}
          </Notice>
        }
      />
    </View>
  );
}
