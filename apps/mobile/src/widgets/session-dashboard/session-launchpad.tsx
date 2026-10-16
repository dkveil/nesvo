import { useState } from 'react';

import { Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import { NesvoLogo } from '@shared/brand';
import { colors as c, mono } from '@shared/theme';
import { Icon } from '@shared/ui';

type SessionLaunchpadProps = {
  active: boolean;
  demo: boolean;
  workspace?: string;
  onCreate: (name: string) => void;
  onLogoLayout: (bottom: number) => void;
};

/** A name draft opens the real CLI/directory form; it is never sent as an AI prompt. */
export function SessionLaunchpad({
  active,
  demo,
  workspace,
  onCreate,
  onLogoLayout,
}: SessionLaunchpadProps) {
  const [name, setName] = useState('');
  const [focused, setFocused] = useState(false);
  const { width } = useWindowDimensions();
  const logoWidth = Math.max(59, Math.floor((Math.min(width, 600) - 32) / 59) * 59);
  function create() {
    onCreate(name.trim());
  }
  return (
    <View style={s.root} accessibilityLabel="Menu startowe">
      <View
        style={s.logo}
        onLayout={event =>
          onLogoLayout(event.nativeEvent.layout.y + event.nativeEvent.layout.height)
        }
      >
        <NesvoLogo width={logoWidth} active={active} testID="workspace-logo" />
      </View>
      <View style={s.context}>
        <Text style={s.path} numberOfLines={1} ellipsizeMode="middle">
          {workspace || (demo ? '~/nesvo' : 'Katalog hosta')}
        </Text>
        <Text style={s.contextMode}>{demo ? 'demo' : 'workspace'}</Text>
      </View>
      <View style={[s.composer, focused && s.composerFocused]}>
        <View style={s.composerRail} aria-hidden pointerEvents="none" />
        <TextInput
          accessibilityLabel="Nazwa nowej sesji"
          placeholder="Nazwij nową sesję…"
          placeholderTextColor={c.muted}
          selectionColor={c.accent}
          value={name}
          onChangeText={setName}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={create}
          maxLength={80}
          style={s.input}
          returnKeyType="next"
          keyboardAppearance="dark"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Nowa sesja z menu startowego"
          onPress={create}
          style={({ pressed }) => [s.create, pressed && s.pressed]}
        >
          <Icon name="arrow-forward" size={18} color={c.accent} />
        </Pressable>
      </View>
      <Text style={s.hint}>
        {demo
          ? 'Podgląd demo. Połącz komputer, aby uruchomić CLI.'
          : 'Dalej wybierzesz CLI i katalog.'}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { paddingTop: 4, paddingBottom: 12 },
  logo: { alignItems: 'center' },
  context: { flexDirection: 'row', gap: 12, marginBottom: 10 },
  path: { flex: 1, fontFamily: mono, fontSize: 11, color: c.faint },
  contextMode: { fontFamily: mono, fontSize: 10, color: c.faint },
  composer: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderLeftWidth: 3,
    borderLeftColor: c.accent,
    paddingLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  composerFocused: { borderColor: c.faint, borderLeftColor: c.accent },
  composerRail: {
    position: 'absolute',
    left: -7,
    top: -1,
    bottom: -1,
    width: 1,
    backgroundColor: c.faint,
    opacity: 0.45,
  },
  input: {
    color: c.text,
    fontFamily: mono,
    fontSize: 14,
    minHeight: 44,
    paddingVertical: 6,
    minWidth: 0,
    flex: 1,
  },
  create: {
    minHeight: 44,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.65 },
  hint: { color: c.faint, fontFamily: mono, fontSize: 10, lineHeight: 16, marginTop: 10 },
});
