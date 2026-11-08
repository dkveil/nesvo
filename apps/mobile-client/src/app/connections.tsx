import { useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Action, Notice, styles } from '@/components/ui';
import { useMobileWorkspace } from '@/hooks/mobile-workspace';

export default function ConnectionsScreen() {
  const store = useMobileWorkspace();
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const forget = async (id: string) => {
    setPending(id);
    setError('');
    try {
      await store.forget(id);
    } catch {
      setError('Could not remove this connection from secure storage.');
    } finally {
      setPending('');
    }
  };
  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={store.connections}
      keyExtractor={item => item.id}
      testID="connections-list"
      ListHeaderComponent={
        <View style={{ gap: 12 }}>
          <Action label="Pair computer" onPress={() => router.push('/pair')} />
          {error && <Notice error>{error}</Notice>}
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open connection: ${item.baseUrl}`}
            testID={`connection-${item.serverId}`}
            onPress={() => {
              store.selectConnection(item.id);
              router.replace('/');
            }}
          >
            <Text selectable style={styles.body}>
              {item.baseUrl}
            </Text>
            <Text selectable style={styles.muted}>
              {item.name}
              {item.id === store.selectedId ? ' · Selected' : ''}
            </Text>
          </Pressable>
          <Action
            label="Forget connection"
            secondary
            disabled={!!pending}
            onPress={() => void forget(item.id)}
            testID={`forget-${item.deviceId}`}
          />
        </View>
      )}
      ListEmptyComponent={<Notice>No paired connections yet.</Notice>}
      ListFooterComponent={
        <Notice>
          Forgetting removes this device’s saved credentials. Revoke the device
          from the desktop to remove its access on the gateway.
        </Notice>
      }
    />
  );
}
