import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { Action, colors, Notice, styles } from '@/components/ui';
import { useMobileWorkspace } from '@/hooks/mobile-workspace';

export default function PairScreen() {
  const store = useMobileWorkspace();
  const headerHeight = useHeaderHeight();
  const [link, setLink] = useState('');
  const [name, setName] = useState('My phone');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const pair = async () => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await store.pair(link, name);
      setLink('');
      router.replace('/');
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Pairing failed. Generate a fresh link and retry.',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <Notice>
          Enable Phone access on your desktop, create a pairing link, then paste
          it here. The link can be used once and expires after two minutes.
        </Notice>
        <Text style={styles.body}>Pairing link</Text>
        <TextInput
          style={[styles.input, { minHeight: 110 }]}
          value={link}
          onChangeText={setLink}
          accessibilityLabel="Pairing link"
          testID="pairing-link"
          multiline
          autoCorrect={false}
          autoCapitalize="none"
          textContentType="none"
          placeholder="nesvo://pair#…"
          placeholderTextColor={colors.muted}
          maxLength={4096}
          editable={!pending}
        />
        <Text style={styles.body}>Device name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          accessibilityLabel="Device name"
          testID="device-name"
          maxLength={80}
          placeholder="My phone"
          placeholderTextColor={colors.muted}
          editable={!pending}
        />
        {error && <Notice error>{error}</Notice>}
        <Action
          label={pending ? 'Pairing…' : 'Pair computer'}
          testID="pair-computer"
          disabled={store.loading || pending || !link.trim() || !name.trim()}
          onPress={() => void pair()}
        />
        <Notice>
          External connections require HTTPS. Pairing credentials are saved in
          device secure storage.
        </Notice>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
