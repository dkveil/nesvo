import { Stack } from 'expo-router';

import AppRoot from '../AppRoot';
import { colors } from '../theme';

export const unstable_settings = { initialRouteName: 'index' };

export default function RootLayout() {
  return (
    <AppRoot>
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="hosts" options={{ animation: 'none' }} />
        <Stack.Screen name="settings" options={{ animation: 'none' }} />
        <Stack.Screen name="session/[id]" />
      </Stack>
    </AppRoot>
  );
}
