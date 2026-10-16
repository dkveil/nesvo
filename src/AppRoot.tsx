import React, { type PropsWithChildren } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import ConnectSheet from './ConnectSheet';
import { Button, common, IconButton } from './components';
import { AppStateProvider, useAppState } from './state/AppState';
import { colors as c } from './theme';
export { DashboardScreen, type DashboardTab } from './DashboardScreen';
function AppModals() {
  const {
    connectOpen,
    setConnectOpen,
    connect,
    createOpen,
    setCreateOpen,
    mode,
    sessionName,
    setSessionName,
    create,
    connected,
  } = useAppState();
  function createSession() {
    Keyboard.dismiss();
    create();
  }
  return (
    <>
      {connectOpen && (
        <ConnectSheet
          onClose={() => setConnectOpen(false)}
          onConnect={(value) => void connect(value)}
        />
      )}
      <Modal
        visible={createOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          Keyboard.dismiss();
          setCreateOpen(false);
        }}
      >
        <SafeAreaProvider>
          <KeyboardAvoidingView
            style={s.overlay}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <SafeAreaView style={s.modalSafe} edges={['top', 'left', 'right']}>
              <SafeAreaView style={s.sheet} edges={['bottom']}>
                <View style={s.headingRow}>
                  <Text style={common.heading}>Nowa sesja</Text>
                  <IconButton
                    name="close"
                    label="Anuluj nową sesję"
                    onPress={() => {
                      Keyboard.dismiss();
                      setCreateOpen(false);
                    }}
                  />
                </View>
                <ScrollView
                  style={s.sheetScroll}
                  contentContainerStyle={s.sheetBody}
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
                >
                  <Text style={common.label}>
                    {mode === 'demo' ? 'Tryb demo' : 'Terminal na komputerze'}
                  </Text>
                  <Text style={common.body}>
                    {mode === 'demo'
                      ? 'Utwórz przykładowy terminal i przetestuj interfejs.'
                      : 'Otwórz powłokę w katalogu skonfigurowanym na hoście. Możesz uruchomić w niej swoje CLI.'}
                  </Text>
                  <TextInput
                    accessibilityLabel="Nazwa sesji"
                    autoFocus
                    placeholder="np. Poprawki w aplikacji"
                    placeholderTextColor={c.faint}
                    value={sessionName}
                    onChangeText={setSessionName}
                    maxLength={80}
                    onSubmitEditing={createSession}
                    style={common.input}
                  />
                  <Button
                    label="Utwórz sesję"
                    icon="add"
                    onPress={createSession}
                    disabled={!sessionName.trim() || (mode === 'live' && !connected)}
                  />
                </ScrollView>
              </SafeAreaView>
            </SafeAreaView>
          </KeyboardAvoidingView>
        </SafeAreaProvider>
      </Modal>
    </>
  );
}

export default function AppRoot({ children }: PropsWithChildren) {
  return (
    <AppStateProvider>
      <SafeAreaProvider style={s.outer}>
        <View style={s.frame}>
          <SafeAreaView style={s.safe} edges={['top', 'bottom', 'left', 'right']}>
            <StatusBar style="light" />
            {children}
            <AppModals />
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </AppStateProvider>
  );
}

const s = StyleSheet.create({
  outer: { flex: 1, backgroundColor: '#000000' },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
    backgroundColor: c.background,
  },
  safe: { flex: 1, backgroundColor: c.background },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  overlay: { flex: 1, backgroundColor: '#00000099', justifyContent: 'flex-end' },
  modalSafe: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: 600,
    maxHeight: '92%',
    alignSelf: 'center',
    padding: 24,
    paddingBottom: 16,
    gap: 20,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    backgroundColor: c.surface,
  },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetBody: { gap: 20, paddingBottom: 24 },
});
