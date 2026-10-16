import { StyleSheet } from 'react-native';

import { colors, mono } from '@shared/theme';

export const common = StyleSheet.create({
  input: {
    color: colors.text,
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 6,
    padding: 14,
    fontSize: 16,
    fontFamily: mono,
    minHeight: 48,
  },
  label: {
    color: colors.muted,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 10,
  },
  body: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  heading: {
    color: colors.text,
    fontFamily: mono,
    fontSize: 21,
    fontWeight: '600',
    letterSpacing: -0.6,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 16,
    gap: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
