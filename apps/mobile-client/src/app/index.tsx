import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Action, Loading, Notice, styles } from '@/components/ui';
import { useMobileWorkspace } from '@/hooks/mobile-workspace';

export default function ComputersScreen() {
  const store = useMobileWorkspace();
  if (store.loading)
    return (
      <View style={styles.screen}>
        <Loading label="Loading saved connections…" />
      </View>
    );
  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={store.view?.computers ?? []}
      keyExtractor={item => item.id}
      testID="computers-list"
      ListHeaderComponent={
        <View style={{ gap: 14 }}>
          <View style={styles.actions}>
            <Action
              label="Connections"
              secondary
              onPress={() => router.push('/connections')}
              testID="open-connections"
            />
            <Action
              label="Pair computer"
              onPress={() => router.push('/pair')}
              testID="open-pair"
            />
          </View>
          {store.storageError && <Notice error>{store.storageError}</Notice>}
          {store.selected && (
            <>
              <Text selectable style={styles.muted}>
                {store.selected.baseUrl}
              </Text>
              <Text testID="connection-status" style={styles.body}>
                {store.status === 'connected'
                  ? 'Connected'
                  : store.status === 'connecting'
                    ? 'Connecting…'
                    : store.status === 'revoked'
                      ? 'Revoked'
                      : store.status === 'unauthorized'
                        ? 'Authorization required'
                        : 'Offline'}
              </Text>
              {store.error && <Notice error>{store.error}</Notice>}
              {store.status !== 'connected' && (
                <Action
                  label="Reconnect"
                  secondary
                  disabled={
                    store.status === 'connecting' ||
                    store.status === 'revoked' ||
                    store.status === 'unauthorized'
                  }
                  onPress={store.reconnect}
                  testID="reconnect"
                />
              )}
            </>
          )}
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open computer: ${item.name}`}
          testID={`computer-${item.id}`}
          style={styles.row}
          onPress={() =>
            router.push({ pathname: '/computer/[id]', params: { id: item.id } })
          }
        >
          <Text selectable style={styles.body}>
            {item.name}
          </Text>
          <Text style={styles.muted}>
            {item.kind === 'local' ? 'Local' : 'SSH'} ·{' '}
            {item.status === 'connected'
              ? 'Connected'
              : item.status === 'syncing'
                ? 'Syncing…'
                : 'Offline'}
            {store.status !== 'connected' ? ' · Saved snapshot' : ''}
          </Text>
        </Pressable>
      )}
      ListEmptyComponent={
        store.selected && store.status === 'connecting' ? (
          <Loading label="Refreshing computers and history…" />
        ) : (
          <View style={{ gap: 12, paddingVertical: 28 }}>
            <Text style={styles.title}>
              {store.selected
                ? 'No snapshot available'
                : 'Connect your workspace'}
            </Text>
            <Notice>
              {store.selected
                ? 'Reconnect to load the computers and sessions from this gateway.'
                : 'Paste a single-use pairing link from Nesvo on your computer. Your provider accounts and files stay there.'}
            </Notice>
          </View>
        )
      }
    />
  );
}
