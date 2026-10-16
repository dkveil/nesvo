import { useIsFocused } from 'expo-router';

import { DashboardScreen } from '@widgets/session-dashboard';

export default function SessionsRoute() {
  const active = useIsFocused();
  return <DashboardScreen tab="sessions" active={active} />;
}
