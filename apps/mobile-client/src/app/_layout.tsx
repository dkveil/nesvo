import { Stack } from 'expo-router/stack';
import { StatusBar } from 'expo-status-bar';
import { MobileWorkspace } from '@/hooks/mobile-workspace';

export default function RootLayout() {
  return (
    <MobileWorkspace>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: '#000000' },
          headerTintColor: '#eeeeee',
          headerShadowVisible: false,
          contentStyle: { backgroundColor: '#000000' },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Nesvo' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair computer' }} />
        <Stack.Screen name="connections" options={{ title: 'Connections' }} />
        <Stack.Screen name="computer/[id]" options={{ title: 'Sessions' }} />
        <Stack.Screen name="session/[id]" options={{ title: 'Conversation' }} />
      </Stack>
    </MobileWorkspace>
  );
}
