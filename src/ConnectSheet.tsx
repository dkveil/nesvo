import React, { useRef, useState } from 'react';
import {
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { parsePairing, type Pairing } from './connection/client';
import { Button, common, Icon, IconButton } from './components';
import { colors as c, mono } from './theme';

export default function ConnectSheet({
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
  function connect(text = value) {
    try {
      const pairing = parsePairing(text);
      setScanning(false);
      onConnect(pairing);
    } catch {
      setError(
        'Nieprawidłowy kod. Użyj pełnego kodu JSON wygenerowanego przez Pocket Sessions Host.',
      );
      setScanning(false);
    }
  }
  async function scan() {
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
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <SafeAreaView style={s.page}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <View style={s.header}>
            <Text style={s.brand}>POCKET SESSIONS</Text>
            <IconButton name="close" label="Zamknij parowanie" onPress={onClose} />
          </View>
          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
            <View style={s.symbol}>
              <Icon name="scan-outline" size={34} color={c.accent} />
            </View>
            <Text style={common.heading}>Twój komputer. Twój terminal.</Text>
            <Text style={common.body}>
              Połącz telefon z uruchomionym hostem. Sesje i narzędzia pozostają na komputerze.
            </Text>
            {scanning ? (
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
                <Button label="Anuluj skanowanie" secondary onPress={() => setScanning(false)} />
              </View>
            ) : (
              <Button label="Zeskanuj kod QR" icon="scan-outline" onPress={scan} />
            )}
            <View style={common.card}>
              <Text style={s.title}>1. Uruchom host na komputerze</Text>
              <Text selectable style={s.code}>
                cargo run --manifest-path host/Cargo.toml -- --lan
              </Text>
              <Text style={common.body}>
                Na początek użyj tego samego Wi-Fi. Zdalny dostęp przez prywatną sieć VPN działa
                również poza domem.
              </Text>
              <Text style={s.title}>2. Wklej kod parowania</Text>
              <Text style={common.body}>
                Kod zawiera klucz dostępu do terminala. Traktuj go jak hasło i nie udostępniaj
                publicznie.
              </Text>
              <TextInput
                accessibilityLabel="Kod parowania JSON"
                value={value}
                onChangeText={setValue}
                placeholder='{"version":1,"url":"ws://…","key":"…"}'
                placeholderTextColor={c.faint}
                autoCorrect={false}
                autoCapitalize="none"
                multiline
                style={[common.input, { fontFamily: mono, fontSize: 12, minHeight: 110 }]}
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
              <Button
                label="Połącz z hostem"
                disabled={!value.trim()}
                icon="arrow-forward"
                onPress={() => connect()}
              />
            </View>
            {!!error && (
              <Text accessibilityRole="alert" style={s.error}>
                {error}
              </Text>
            )}
            <Text style={s.footnote}>
              Nie potrzebujesz klucza API do AI. Claude Code i Codex uruchamiasz w terminalu,
              używając własnego logowania.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  brand: { color: c.faint, fontSize: 11, fontWeight: '700', letterSpacing: 2 },
  content: { padding: 24, gap: 20, maxWidth: 540, width: '100%', alignSelf: 'center' },
  symbol: {
    backgroundColor: c.surface,
    width: 64,
    height: 64,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: c.text, fontSize: 15, fontWeight: '600' },
  code: { color: c.accent, fontFamily: mono, fontSize: 12, lineHeight: 21 },
  error: { color: c.danger, fontSize: 13, lineHeight: 20 },
  footnote: { color: c.faint, fontSize: 12, lineHeight: 19 },
  camera: { height: 320, overflow: 'hidden', borderRadius: 16, gap: 10 },
});
