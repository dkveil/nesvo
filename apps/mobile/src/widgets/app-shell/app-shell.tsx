import type { PropsWithChildren } from 'react';

import { StyleSheet, View } from 'react-native';

import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { NewSessionSheet } from '@features/create-session';
import { ConnectSheet } from '@features/pair-host';

import { useWorkspace, WorkspaceProvider } from '@entities/workspace';

import { colors } from '@shared/theme';

import { workspaceNavigation } from './workspace-navigation';

function WorkspaceModals() {
  const { connectOpen, setConnectOpen, connect, createOpen } = useWorkspace();
  return (
    <>
      {!!connectOpen && (
        <ConnectSheet
          onClose={() => setConnectOpen(false)}
          onConnect={value => void connect(value)}
        />
      )}
      {!!createOpen && <NewSessionSheet />}
    </>
  );
}

export function AppShell({ children }: PropsWithChildren) {
  return (
    <WorkspaceProvider navigation={workspaceNavigation}>
      <SafeAreaProvider style={styles.outer}>
        <View style={styles.frame}>
          <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
            <StatusBar style="light" />
            {children}
            <WorkspaceModals />
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </WorkspaceProvider>
  );
}

const styles = StyleSheet.create({
  outer: { flex: 1, backgroundColor: colors.background },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
    backgroundColor: colors.background,
  },
  safe: { flex: 1, backgroundColor: colors.background },
});
