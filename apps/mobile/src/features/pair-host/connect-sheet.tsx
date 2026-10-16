import React, { useRef, useState } from 'react';

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

import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { type Pairing, parsePairing } from '@shared/api/host';
import { colors as c, mono } from '@shared/theme';
import { Button, IconButton } from '@shared/ui';

export function ConnectSheet({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (pairing: Pairing) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const scanConsumed = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  function close() {
    Keyboard.dismiss();
    onClose();
  }
  function connect(text = value) {
    try {
      const pairing = parsePairing(text);
      Keyboard.dismiss();
      setScanning(false);
      onConnect(pairing);
    } catch {
      setError('Nieprawidłowy kod. Wklej cały kod parowania wygenerowany na komputerze.');
      setScanning(false);
    }
  }
  async function scan() {
    Keyboard.dismiss();
    if (Platform.OS === 'web') {
      setError(
        'W podglądzie przeglądarkowym wklej kod. Skaner QR jest dostępny w aplikacji na telefonie.',
      );
      return;
    }
    const result = permission?.granted ? permission : await requestPermission();
    if (result.granted) {
      setError('');
      scanConsumed.current = false;
      setScanning(true);
    } else
      setError(
        'Aparat nie ma uprawnień. Możesz wkleić kod lub przyznać dostęp w ustawieniach telefonu.',
      );
  }
  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      onShow={Keyboard.dismiss}
      presentationStyle="pageSheet"
    >
      <SafeAreaProvider>
        <SafeAreaView
          style={s.page}
          edges={Platform.OS === 'ios' ? ['top', 'left', 'right'] : undefined}
        >
          <KeyboardAvoidingView
            enabled={Platform.OS === 'android'}
            behavior="height"
            style={s.flex}
          >
            <View style={s.header}>
              <Text accessibilityRole="header" style={s.heading}>
                Połącz komputer
              </Text>
              <IconButton name="close" label="Zamknij parowanie" onPress={close} />
            </View>
            {/* iOS measures keyboard overlap inside the sheet in native screen coordinates. */}
            <ScrollView
              style={s.flex}
              contentContainerStyle={s.content}
              contentInsetAdjustmentBehavior="automatic"
              automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              keyboardShouldPersistTaps="handled"
              indicatorStyle="white"
            >
              <Text style={s.body}>
                Zeskanuj kod QR z komputera, aby otworzyć jego terminale na telefonie.
              </Text>
              <View style={s.steps}>
                <View style={s.step}>
                  <Text style={s.stepNumber}>1</Text>
                  <View style={s.stepContent}>
                    <Text style={s.title}>Uruchom host na komputerze</Text>
                    <Text selectable style={s.code}>
                      cargo run --manifest-path apps/host/Cargo.toml -- --lan
                    </Text>
                  </View>
                </View>
                <View style={s.step}>
                  <Text style={s.stepNumber}>2</Text>
                  <View style={s.stepContent}>
                    <Text style={s.title}>Otwórz kod QR</Text>
                    <Text style={s.body}>
                      Otwórz plik pairing.svg wskazany w terminalu. Na początek użyj tej samej sieci
                      Wi-Fi.
                    </Text>
                  </View>
                </View>
              </View>
              {scanning ? (
                <View style={s.scanner}>
                  <View style={s.camera}>
                    <CameraView
                      style={{ flex: 1 }}
                      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                      onBarcodeScanned={({ data }) => {
                        if (scanConsumed.current) return;
                        scanConsumed.current = true;
                        connect(data);
                      }}
                    />
                  </View>
                  <Button label="Anuluj skanowanie" secondary onPress={() => setScanning(false)} />
                </View>
              ) : (
                <Button label="Zeskanuj kod QR" icon="scan-outline" onPress={scan} />
              )}
              <View style={s.divider}>
                <View style={s.line} />
                <Text style={s.dividerLabel}>lub wklej kod</Text>
                <View style={s.line} />
              </View>
              <View style={s.manual}>
                <TextInput
                  accessibilityLabel="Kod parowania JSON"
                  value={value}
                  onChangeText={setValue}
                  placeholder="Kod parowania z komputera"
                  placeholderTextColor={c.faint}
                  selectionColor={c.accent}
                  autoCorrect={false}
                  autoCapitalize="none"
                  autoComplete="off"
                  textContentType="none"
                  spellCheck={false}
                  returnKeyType="done"
                  submitBehavior="blurAndSubmit"
                  onSubmitEditing={Keyboard.dismiss}
                  multiline
                  textAlignVertical="top"
                  style={s.input}
                />
                <Button
                  label="Wklej ze schowka"
                  secondary
                  icon="clipboard-outline"
                  onPress={async () => {
                    try {
                      setValue(await Clipboard.getStringAsync());
                    } catch {
                      setError('Nie udało się odczytać schowka. Wklej kod ręcznie.');
                    }
                  }}
                />
                {!!error && (
                  <Text accessibilityRole="alert" style={s.error}>
                    {error}
                  </Text>
                )}
                <Button
                  label="Połącz z hostem"
                  disabled={!value.trim()}
                  icon="arrow-forward"
                  onPress={() => connect()}
                />
                <Text style={s.helper}>
                  Kod daje dostęp do Twojego terminala. Zachowaj go dla siebie.
                </Text>
              </View>
              <Text style={s.footnote}>
                Wszystko działa na Twoim komputerze. Claude Code i Codex używają Twojego logowania w
                terminalu.
              </Text>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}
const s = StyleSheet.create({
  flex: { flex: 1 },
  page: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingLeft: 18,
    paddingRight: 8,
    paddingTop: 8,
    paddingBottom: 12,
  },
  heading: {
    color: c.text,
    fontFamily: mono,
    fontSize: 19,
    fontWeight: '600',
    letterSpacing: -0.4,
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 36,
    gap: 20,
    maxWidth: 540,
    width: '100%',
    alignSelf: 'center',
  },
  body: { color: c.muted, fontSize: 14, lineHeight: 22 },
  steps: { gap: 24 },
  step: { flexDirection: 'row', gap: 16 },
  stepNumber: { color: c.accent, fontFamily: mono, fontSize: 14, lineHeight: 24, width: 12 },
  stepContent: { flex: 1, gap: 10 },
  title: { color: c.text, fontFamily: mono, fontSize: 14, fontWeight: '500', lineHeight: 24 },
  code: {
    color: c.muted,
    fontFamily: mono,
    fontSize: 12,
    lineHeight: 20,
    backgroundColor: c.surface,
    padding: 12,
    borderRadius: 6,
    overflow: 'hidden',
  },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 2 },
  dividerLabel: { color: c.faint, fontSize: 14 },
  line: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, flex: 1 },
  manual: { gap: 12 },
  input: {
    color: c.text,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    padding: 16,
    fontSize: 16,
    fontFamily: mono,
    lineHeight: 24,
    minHeight: 112,
    maxHeight: 180,
  },
  helper: { color: c.muted, fontSize: 14, lineHeight: 21, marginTop: 2 },
  error: { color: c.danger, fontSize: 15, lineHeight: 22 },
  footnote: { color: c.faint, fontSize: 14, lineHeight: 22, paddingTop: 4 },
  scanner: { gap: 12 },
  camera: { height: 280, overflow: 'hidden', borderRadius: 8 },
});
