import { useState } from 'react';

import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { flattenGroups, groupDescendants, GroupPicker, validGroupName } from '@entities/group';
import { useWorkspace } from '@entities/workspace';

import { colors as c, mono } from '@shared/theme';
import { Button, common, Icon, IconButton } from '@shared/ui';

type Editor = { id: string | null; name: string; parentId: string | null; order: number };

export function GroupsScreen() {
  const {
    groups,
    revision,
    sessions,
    mode,
    connected,
    selectedGroup,
    setSelectedGroup,
    createGroup,
    updateGroup,
    deleteGroup,
    notice,
    setNotice,
    navigateTo,
  } = useWorkspace();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorRevision, setEditorRevision] = useState(revision);
  const [showParents, setShowParents] = useState(false);
  const insets = useSafeAreaInsets();
  const canEdit = mode === 'demo' || connected;
  const empty =
    !!editor?.id &&
    !groups.some(group => group.parentId === editor.id) &&
    !sessions.some(session => session.groupId === editor.id);
  function select(id: string | null) {
    setSelectedGroup(id);
    navigateTo('sessions');
  }
  function edit(value: Editor) {
    setShowParents(false);
    setEditor(value);
    setEditorRevision(revision);
  }
  function save() {
    if (!editor) return;
    const saved = editor.id
      ? updateGroup({ ...editor, id: editor.id }, editorRevision)
      : createGroup(editor.name, editor.parentId, editorRevision);
    if (saved) {
      Keyboard.dismiss();
      setEditor(null);
    }
  }
  return (
    <KeyboardAvoidingView
      style={s.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <View style={s.header}>
        <IconButton
          name="chevron-back"
          label="Wróć do sesji"
          onPress={() => {
            Keyboard.dismiss();
            navigateTo('sessions');
          }}
        />
        <Text style={s.title}>Grupy</Text>
        <IconButton
          name="add"
          label="Nowa grupa"
          onPress={() => edit({ id: null, name: '', parentId: null, order: 0 })}
        />
      </View>
      <ScrollView
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      >
        <Text style={common.body}>
          {mode === 'demo'
            ? 'Grupy przykładowe · zmiany pozostają w tym podglądzie.'
            : 'Ten sam porządek sesji na telefonie i komputerze.'}
        </Text>
        {!canEdit && <Text style={s.hint}>Połącz host, aby zmieniać grupy.</Text>}
        {editor ? (
          <View style={s.form}>
            <Text style={s.formTitle}>
              {editor.id ? 'Edytuj grupę' : editor.parentId ? 'Nowa podgrupa' : 'Nowa grupa'}
            </Text>
            <TextInput
              accessibilityLabel="Nazwa grupy"
              placeholder="np. Projekty"
              placeholderTextColor={c.faint}
              autoFocus
              value={editor.name}
              onChangeText={name => setEditor({ ...editor, name })}
              maxLength={80}
              onSubmitEditing={save}
              style={common.input}
              keyboardAppearance="dark"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Wybierz grupę nadrzędną"
              onPress={() => setShowParents(!showParents)}
              style={s.parent}
            >
              <Icon name="folder-outline" />
              <Text style={s.growText}>
                {editor.parentId
                  ? groups.find(group => group.id === editor.parentId)?.name
                  : 'Na głównym poziomie'}
              </Text>
              <Icon name={showParents ? 'chevron-up' : 'chevron-down'} />
            </Pressable>
            {!!showParents && (
              <GroupPicker
                groups={groups}
                value={editor.parentId}
                onChange={parentId => setEditor({ ...editor, parentId })}
                excluded={editor.id ? groupDescendants(groups, editor.id) : undefined}
                rootLabel="Na głównym poziomie"
              />
            )}
            <Button
              label={editor.id ? 'Zapisz grupę' : 'Utwórz grupę'}
              disabled={!canEdit || !validGroupName(editor.name)}
              onPress={save}
            />
            <Button
              label="Anuluj edycję grupy"
              secondary
              onPress={() => {
                Keyboard.dismiss();
                setEditor(null);
              }}
            />
            {!!editor.id && (
              <>
                <Button
                  label="Usuń pustą grupę"
                  secondary
                  disabled={!canEdit || !empty}
                  onPress={() => {
                    if (editor.id && deleteGroup(editor.id, editorRevision)) setEditor(null);
                  }}
                />
                {!empty && (
                  <Text style={s.hint}>
                    Przenieś sesje i usuń podgrupy, zanim usuniesz tę grupę.
                  </Text>
                )}
              </>
            )}
          </View>
        ) : (
          <>
            {[
              { id: 'all', name: 'Wszystkie sesje' },
              { id: null, name: 'Bez grupy' },
            ].map(item => (
              <Pressable
                key={item.id ?? 'ungrouped'}
                accessibilityRole="button"
                accessibilityLabel={item.name}
                onPress={() => select(item.id)}
                style={[s.row, selectedGroup === item.id && s.selected]}
              >
                <Icon name="albums-outline" />
                <Text style={s.growText}>{item.name}</Text>
                <Text style={s.count}>
                  {item.id === 'all'
                    ? sessions.length
                    : sessions.filter(session => !session.groupId).length}
                </Text>
              </Pressable>
            ))}
            {flattenGroups(groups).map(group => (
              <View
                key={group.id}
                style={[
                  s.row,
                  { paddingLeft: 12 + Math.min(group.depth, 5) * 12 },
                  selectedGroup === group.id && s.selected,
                ]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Pokaż grupę ${group.name}`}
                  onPress={() => select(group.id)}
                  style={s.groupSelect}
                >
                  <Icon
                    name={group.depth ? 'return-down-forward-outline' : 'folder-outline'}
                    size={18}
                  />
                  <Text style={s.growText} numberOfLines={2}>
                    {group.name}
                  </Text>
                  <Text style={s.count}>
                    {
                      sessions.filter(
                        session =>
                          session.groupId &&
                          groupDescendants(groups, group.id).has(session.groupId),
                      ).length
                    }
                  </Text>
                </Pressable>
                <IconButton
                  name="add"
                  label={`Dodaj podgrupę do ${group.name}`}
                  onPress={() => edit({ id: null, name: '', parentId: group.id, order: 0 })}
                />
                <IconButton
                  name="ellipsis-horizontal"
                  label={`Edytuj grupę ${group.name}`}
                  onPress={() => edit(group)}
                />
              </View>
            ))}
            {!groups.length && (
              <Text style={s.hint}>
                Utwórz pierwszą grupę, a potem dodaj do niej podgrupy i sesje.
              </Text>
            )}
            <Button
              label="Dodaj grupę"
              icon="add"
              secondary
              disabled={!canEdit}
              onPress={() => edit({ id: null, name: '', parentId: null, order: 0 })}
            />
          </>
        )}
        {!!notice && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Ukryj komunikat"
            onPress={() => setNotice('')}
          >
            <Text style={s.hint}>{notice}</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    minHeight: 54,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  title: {
    flex: 1,
    color: c.text,
    fontFamily: mono,
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 6,
  },
  content: { padding: 16, gap: 10 },
  row: {
    minHeight: 48,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    paddingHorizontal: 12,
    borderRadius: 4,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  selected: { backgroundColor: c.surface, borderLeftColor: c.accent },
  groupSelect: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  growText: { flex: 1, color: c.text, fontFamily: mono, fontSize: 13, lineHeight: 22 },
  count: { color: c.faint, fontFamily: mono, fontSize: 11 },
  form: {
    backgroundColor: c.surface,
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.border,
    gap: 14,
  },
  formTitle: { color: c.text, fontFamily: mono, fontSize: 17, fontWeight: '600' },
  hint: { color: c.muted, fontSize: 13, lineHeight: 21, paddingVertical: 8 },
  parent: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
});
