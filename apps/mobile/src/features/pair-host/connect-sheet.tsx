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
import { useMotionPreference } from '@shared/brand';
import { colors as c, mono } from '@shared/theme';
import { Button, IconButton } from '@shared/ui';

export function ConnectSheet({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: (pairing: Pairing) => void;
}) {
  const motionAllowed = useMotionPreference();
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
      setError('Invalid code. Paste the whole pairing code generated on the computer.');
      setScanning(false);
    }
  }
  async function scan() {
    Keyboard.dismiss();
    if (Platform.OS === 'web') {
      setError(
        'In the browser preview, paste the code. The QR scanner is available in the phone app.',
      );
      return;
    }
    const result = permission?.granted ? permission : await requestPermission();
    if (result.granted) {
      setError('');
      scanConsumed.current = false;
      setScanning(true);
    } else
      setError('The camera has no permission. Paste the code or allow access in phone settings.');
  }
  return (
    <Modal
      animationType={motionAllowed ? 'slide' : 'fade'}
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
                Connect a computer
              </Text>
              <IconButton name="close" label="Close pairing" onPress={close} />
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
                Connect your phone directly to a nesvo host on the same network or a private VPN.
              </Text>
              <View style={s.steps}>
                <View style={s.step}>
                  <Text style={s.stepNumber}>1</Text>
                  <View style={s.stepContent}>
                    <Text style={s.title}>Start the host on your computer</Text>
                    <Text selectable style={s.code}>
                      cargo run --manifest-path apps/host/Cargo.toml -- --lan
                    </Text>
                  </View>
                </View>
                <View style={s.step}>
                  <Text style={s.stepNumber}>2</Text>
                  <View style={s.stepContent}>
                    <Text style={s.title}>Open the QR code</Text>
                    <Text style={s.body}>Open the pairing.svg file the host points to.</Text>
                  </View>
                </View>
                <View style={s.step}>
                  <Text style={s.stepNumber}>3</Text>
                  <View style={s.stepContent}>
                    <Text style={s.title}>Scan the code with your phone</Text>
                    <Text style={s.body}>The connection appears on the Computers screen.</Text>
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
                  <Button label="Cancel scanning" secondary onPress={() => setScanning(false)} />
                </View>
              ) : (
                <Button label="Scan QR code" icon="scan-outline" onPress={scan} />
              )}
              <View style={s.divider}>
                <View style={s.line} />
                <Text style={s.dividerLabel}>or paste the code</Text>
                <View style={s.line} />
              </View>
              <View style={s.manual}>
                <TextInput
                  accessibilityLabel="Pairing code JSON"
                  value={value}
                  onChangeText={setValue}
                  placeholder="Pairing code from the computer"
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
                  label="Paste from clipboard"
                  secondary
                  icon="clipboard-outline"
                  onPress={async () => {
                    try {
                      setValue(await Clipboard.getStringAsync());
                    } catch {
                      setError('Could not read the clipboard. Paste the code manually.');
                    }
                  }}
                />
                {!!error && (
                  <Text accessibilityRole="alert" style={s.error}>
                    {error}
                  </Text>
                )}
                <Button
                  label="Connect to host"
                  disabled={!value.trim()}
                  icon="arrow-forward"
                  onPress={() => connect()}
                />
                <Text style={s.helper}>
                  The code grants access to your terminal. Keep it to yourself.
                </Text>
              </View>
              <Text style={s.footnote}>
                Everything runs on your computer. Claude Code and Codex use your terminal sign-in.
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
  steps: { gap: 16 },
  step: { flexDirection: 'row', gap: 16 },
  stepNumber: { color: c.accent, fontFamily: mono, fontSize: 14, lineHeight: 24, width: 12 },
  stepContent: { flex: 1, gap: 4 },
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
