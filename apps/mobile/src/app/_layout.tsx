import { Stack } from 'expo-router';

import { AppShell } from '@widgets/app-shell';

import { useMotionPreference } from '@shared/brand';
import { colors } from '@shared/theme';

export const unstable_settings = { initialRouteName: 'index' };

export default function RootLayout() {
  const motionAllowed = useMotionPreference();
  return (
    <AppShell>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="hosts" options={{ animation: 'none' }} />
        <Stack.Screen name="settings" options={{ animation: 'none' }} />
        <Stack.Screen name="inbox" options={{ animation: motionAllowed ? 'default' : 'fade' }} />
        <Stack.Screen
          name="decisions"
          options={{ animation: motionAllowed ? 'default' : 'fade' }}
        />
        <Stack.Screen
          name="session/[id]"
          options={{ animation: motionAllowed ? 'default' : 'fade' }}
        />
      </Stack>
    </AppShell>
  );
}
