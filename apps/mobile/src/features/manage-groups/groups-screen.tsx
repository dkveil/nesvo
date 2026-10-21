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
          label="Back to sessions"
          onPress={() => {
            Keyboard.dismiss();
            navigateTo('sessions');
          }}
        />
        <Text style={s.title}>Groups</Text>
        <IconButton
          name="add"
          label="New group"
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
            ? 'Sample groups · changes stay in this preview.'
            : 'The same session order on your phone and computer.'}
        </Text>
        {!canEdit && <Text style={s.hint}>Connect a host to change groups.</Text>}
        {editor ? (
          <View style={s.form}>
            <Text style={s.formTitle}>
              {editor.id ? 'Edit group' : editor.parentId ? 'New subgroup' : 'New group'}
            </Text>
            <TextInput
              accessibilityLabel="Group name"
              placeholder="e.g. Projects"
              placeholderTextColor={c.faint}
              selectionColor={c.accent}
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
              accessibilityLabel="Choose a parent group"
              onPress={() => setShowParents(!showParents)}
              style={s.parent}
            >
              <Icon name="folder-outline" />
              <Text style={s.growText}>
                {editor.parentId
                  ? groups.find(group => group.id === editor.parentId)?.name
                  : 'At the top level'}
              </Text>
              <Icon name={showParents ? 'chevron-up' : 'chevron-down'} />
            </Pressable>
            {!!showParents && (
              <GroupPicker
                groups={groups}
                value={editor.parentId}
                onChange={parentId => setEditor({ ...editor, parentId })}
                excluded={editor.id ? groupDescendants(groups, editor.id) : undefined}
                rootLabel="At the top level"
              />
            )}
            <Button
              label={editor.id ? 'Save group' : 'Create group'}
              disabled={!canEdit || !validGroupName(editor.name)}
              onPress={save}
            />
            <Button
              label="Cancel group editing"
              secondary
              onPress={() => {
                Keyboard.dismiss();
                setEditor(null);
              }}
            />
            {!!editor.id && (
              <>
                <Button
                  label="Delete empty group"
                  secondary
                  disabled={!canEdit || !empty}
                  onPress={() => {
                    if (editor.id && deleteGroup(editor.id, editorRevision)) setEditor(null);
                  }}
                />
                {!empty && (
                  <Text style={s.hint}>
                    Move sessions and delete subgroups before deleting this group.
                  </Text>
                )}
              </>
            )}
          </View>
        ) : (
          <>
            {[
              { id: 'all', name: 'All sessions' },
              { id: null, name: 'No group' },
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
                  accessibilityLabel={`Show group ${group.name}`}
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
                  label={`Add a subgroup to ${group.name}`}
                  onPress={() => edit({ id: null, name: '', parentId: group.id, order: 0 })}
                />
                <IconButton
                  name="ellipsis-horizontal"
                  label={`Edit group ${group.name}`}
                  onPress={() => edit(group)}
                />
              </View>
            ))}
            {!groups.length && (
              <Text style={s.hint}>
                Create a first group, then add subgroups and sessions to it.
              </Text>
            )}
            <Button
              label="Add group"
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
            accessibilityLabel="Dismiss message"
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
