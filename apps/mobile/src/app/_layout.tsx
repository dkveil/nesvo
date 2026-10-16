import { Stack } from 'expo-router';

import { AppShell } from '@widgets/app-shell';

import { colors } from '@shared/theme';

export const unstable_settings = { initialRouteName: 'index' };

export default function RootLayout() {
  return (
    <AppShell>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="hosts" options={{ animation: 'none' }} />
        <Stack.Screen name="settings" options={{ animation: 'none' }} />
        <Stack.Screen name="session/[id]" />
      </Stack>
    </AppShell>
  );
}
