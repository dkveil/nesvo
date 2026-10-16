import { useState } from 'react';

import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { groupPath, GroupPicker } from '@entities/group';
import { programLabels } from '@entities/session';
import { useWorkspace } from '@entities/workspace';

import type { SessionProgram } from '@shared/api/host';
import { colors as c, mono } from '@shared/theme';
import { Button, common, Icon, IconButton } from '@shared/ui';

const PROGRAMS: SessionProgram[] = ['shell', 'claude', 'gemini', 'codex'];
const DEMO_CWD = '~/projects/workspace';

export function NewSessionSheet() {
  const {
    mode,
    connected,
    hostCapabilities,
    sessionGroup,
    sessionName,
    groups,
    create,
    creating,
    createError,
    setCreateError,
    setCreateOpen,
  } = useWorkspace();
  // Draft fields stay in the sheet; typing must not rerender every route and terminal.
  const [name, setName] = useState(sessionName);
  const [cwdDraft, setCwdDraft] = useState<string | null>(null);
  const [program, setProgram] = useState<SessionProgram>('shell');
  const [groupId, setGroupId] = useState(sessionGroup);
  const [chooseGroup, setChooseGroup] = useState(false);
  const demo = mode === 'demo';
  const cwd = demo ? DEMO_CWD : (cwdDraft ?? hostCapabilities?.workspace ?? '');
  const selectedAvailable = demo
    ? program === 'shell'
    : !!hostCapabilities?.programs.some(item => item.id === program && item.available);
  const directoryName = cwd.split(/[\\/]/).filter(Boolean).at(-1);
  const defaultName = Array.from(
    `${programLabels[program]}${directoryName ? ` · ${directoryName}` : ''}`,
  )
    .slice(0, 80)
    .join('');
  const canCreate = !creating && !!cwd.trim() && selectedAvailable && (demo || connected);

  function close() {
    Keyboard.dismiss();
    setCreateError('');
    setCreateOpen(false);
  }
  function submit() {
    if (!canCreate) return;
    Keyboard.dismiss();
    create({ name: name.trim() || defaultName, cwd, program, groupId });
  }

  return (
    <Modal visible transparent animationType="none" onRequestClose={close}>
      <SafeAreaProvider>
        <KeyboardAvoidingView
          style={s.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <SafeAreaView style={s.modalSafe} edges={['top', 'left', 'right']}>
            <SafeAreaView style={s.sheet} edges={['bottom']} accessibilityViewIsModal>
              <View style={s.headingRow}>
                <Text style={common.heading}>Nowa sesja</Text>
                <IconButton name="close" label="Anuluj nową sesję" onPress={close} />
              </View>
              <ScrollView
                style={s.scroll}
                contentContainerStyle={s.body}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              >
                <Text style={s.explanation}>
                  {demo
                    ? 'Tryb demo · tylko fikcyjny terminal. Połącz komputer, aby uruchamiać swoje CLI.'
                    : 'Wybierz narzędzie i katalog na połączonym komputerze.'}
                </Text>
                <View style={s.programs} accessibilityLabel="Narzędzie sesji">
                  {PROGRAMS.map(id => {
                    const capability = hostCapabilities?.programs.find(item => item.id === id);
                    const available = demo
                      ? id === 'shell'
                      : connected && capability?.available === true;
                    const status = demo
                      ? id === 'shell'
                        ? 'Podgląd demo'
                        : 'Połącz komputer'
                      : !connected
                        ? 'Host rozłączony'
                        : !hostCapabilities
                          ? 'Sprawdzanie…'
                          : available
                            ? 'Dostępne'
                            : 'Nie znaleziono';
                    return (
                      <Pressable
                        key={id}
                        accessibilityRole="radio"
                        accessibilityLabel={programLabels[id]}
                        aria-checked={program === id}
                        accessibilityState={{
                          checked: program === id,
                          disabled: !available || creating,
                        }}
                        disabled={!available || creating}
                        onPress={() => setProgram(id)}
                        style={({ pressed }) => [
                          s.program,
                          program === id && s.selectedProgram,
                          !available && s.unavailable,
                          pressed && s.pressed,
                        ]}
                      >
                        <View style={s.programTitle}>
                          <Icon
                            name={id === 'shell' ? 'terminal-outline' : 'code-slash-outline'}
                            size={18}
                            color={c.text}
                          />
                          <Text style={s.programName}>{programLabels[id]}</Text>
                          {program === id && <Icon name="checkmark" size={16} color={c.text} />}
                        </View>
                        <Text style={s.programStatus}>{status}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <View style={s.field}>
                  <Text style={s.label}>Katalog roboczy</Text>
                  <TextInput
                    accessibilityLabel="Katalog roboczy"
                    value={cwd}
                    onChangeText={setCwdDraft}
                    editable={!demo && !creating}
                    placeholder={
                      connected ? 'Ścieżka do folderu na komputerze' : 'Najpierw połącz komputer'
                    }
                    placeholderTextColor={c.faint}
                    selectionColor={c.accent}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    spellCheck={false}
                    keyboardAppearance="dark"
                    style={common.input}
                  />
                  <Text style={s.hint}>
                    {demo
                      ? 'To przykładowa ścieżka, bez dostępu do plików.'
                      : 'Podaj ścieżkę istniejącego folderu. Ścieżki względne są liczone od katalogu hosta.'}
                  </Text>
                </View>
                <View style={s.field}>
                  <Text style={s.label}>
                    Nazwa sesji <Text style={s.optional}>· opcjonalnie</Text>
                  </Text>
                  <TextInput
                    accessibilityLabel="Nazwa sesji"
                    value={name}
                    onChangeText={setName}
                    editable={!creating}
                    placeholder={defaultName}
                    placeholderTextColor={c.faint}
                    selectionColor={c.accent}
                    maxLength={80}
                    onSubmitEditing={submit}
                    returnKeyType="done"
                    keyboardAppearance="dark"
                    style={common.input}
                  />
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Wybierz grupę nowej sesji"
                  onPress={() => setChooseGroup(!chooseGroup)}
                  style={s.groupChoice}
                >
                  <Icon name="folder-outline" size={18} />
                  <Text style={s.groupName}>{groupPath(groups, groupId)}</Text>
                  <Icon name={chooseGroup ? 'chevron-up' : 'chevron-down'} size={16} />
                </Pressable>
                {!!chooseGroup && (
                  <GroupPicker
                    groups={groups}
                    value={groupId}
                    onChange={setGroupId}
                    disabled={creating}
                  />
                )}
                {!!createError && (
                  <Text accessibilityRole="alert" style={s.error}>
                    {createError}
                  </Text>
                )}
                <Button
                  label={creating ? 'Tworzenie sesji…' : 'Utwórz sesję'}
                  icon="add"
                  onPress={submit}
                  disabled={!canCreate}
                />
                {!demo && (
                  <Text style={s.hint}>
                    Lista pochodzi z hosta. Po instalacji nowego CLI uruchom host ponownie.
                    Logowanie odbywa się w oryginalnym CLI.
                  </Text>
                )}
              </ScrollView>
            </SafeAreaView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </SafeAreaProvider>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#00000099', justifyContent: 'flex-end' },
  modalSafe: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxWidth: 600,
    maxHeight: '92%',
    alignSelf: 'center',
    padding: 18,
    paddingBottom: 12,
    gap: 14,
    borderTopWidth: 1,
    borderColor: c.border,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    backgroundColor: c.surface,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  scroll: { flexGrow: 0, flexShrink: 1 },
  body: { gap: 14, paddingBottom: 14 },
  explanation: { color: c.muted, fontSize: 13, lineHeight: 20 },
  programs: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  program: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 72,
    borderRadius: 6,
    padding: 12,
    borderWidth: 1,
    borderColor: c.border,
    gap: 7,
  },
  selectedProgram: { backgroundColor: c.elevated, borderColor: c.accent },
  programTitle: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  programName: { flex: 1, color: c.text, fontFamily: mono, fontSize: 12, fontWeight: '500' },
  programStatus: { color: c.muted, fontFamily: mono, fontSize: 10 },
  unavailable: { opacity: 0.55 },
  pressed: { opacity: 0.7 },
  field: { gap: 9 },
  label: { color: c.text, fontFamily: mono, fontSize: 12, fontWeight: '500' },
  optional: { color: c.faint, fontWeight: '400' },
  hint: { color: c.faint, fontSize: 12, lineHeight: 18 },
  groupChoice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 },
  groupName: { flex: 1, color: c.muted, fontFamily: mono, fontSize: 12 },
  error: { color: c.danger, fontSize: 13, lineHeight: 20 },
});
