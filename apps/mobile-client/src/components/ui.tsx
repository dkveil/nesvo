import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button, Host } from '@expo/ui';

export const colors = {
  background: '#000000',
  panel: '#0d0d0d',
  text: '#eeeeee',
  muted: '#a1a1a1',
  border: '#242424',
  error: '#f2a2a2',
};

export function Action({
  label,
  onPress,
  disabled = false,
  testID,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  secondary?: boolean;
}) {
  return (
    <Host
      colorScheme="dark"
      seedColor="#999999"
      matchContents
      style={{ minHeight: 48, minWidth: 96 }}
    >
      <Button
        label={label}
        onPress={onPress}
        disabled={disabled}
        testID={testID}
        variant={secondary ? 'outlined' : 'filled'}
      />
    </Host>
  );
}

export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <Text
      selectable
      accessibilityRole={error ? 'alert' : undefined}
      style={[styles.notice, error && { color: colors.error }]}
    >
      {children}
    </Text>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.muted} />
      <Notice>{label}</Notice>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 16 },
  title: { color: colors.text, fontSize: 20, fontWeight: '600' },
  body: { color: colors.text, fontSize: 15, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  notice: { color: colors.muted, fontSize: 13, lineHeight: 21 },
  row: {
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: 5,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.panel,
    color: colors.text,
    padding: 14,
    fontSize: 15,
    minHeight: 50,
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  loading: { padding: 20, alignItems: 'center', gap: 12 },
  card: {
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    backgroundColor: colors.panel,
    gap: 10,
  },
});
