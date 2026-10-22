import React, { useEffect, useRef, useState } from 'react';

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

import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { groupPath, GroupPicker } from '@entities/group';
import {
  createDemoShell,
  type Session,
  sessionAgentColor,
  SessionStatusBadge,
} from '@entities/session';
import { useWorkspace } from '@entities/workspace';

import type { HostClient, SessionControl } from '@shared/api/host';
import { useMotionPreference } from '@shared/brand';
import { type TerminalHandle, TerminalView } from '@shared/terminal';
import { colors as c, mono } from '@shared/theme';
import { Button, common, Icon, IconButton } from '@shared/ui';

export function SessionScreen({
  session,
  client,
  connected,
  onBack,
  onClose,
}: {
  session: Session;
  client: HostClient;
  connected: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  const motionAllowed = useMotionPreference();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [control, setControl] = useState<SessionControl | undefined>(() =>
    client.getControl(session.id),
  );
  const [watching, setWatching] = useState(false);
  const { groups, moveSession, hostCapabilities } = useWorkspace();
  useEffect(() => {
    if (connected && session.live && session.attention?.unread)
      client.acknowledgeAttention(session.id, session.attention.sequence);
  }, [client, connected, session.id, session.live, session.attention]);
  const controlling =
    !!session.live && connected && control?.controllerId === client.clientId && !!control?.leaseId;
  const canType = !session.live || (controlling && session.running !== false);
  const showControl = !!session.live && connected && session.running !== false;
  const terminal = useRef<TerminalHandle>(null);
  const composerInput = useRef<TextInput>(null);
  const size = useRef({ cols: 80, rows: 24 });
  const ready = useRef(false);
  const subscribed = useRef(false);
  const demo = useRef<ReturnType<typeof createDemoShell> | null>(null);
  useEffect(
    () =>
      client.subscribe(event => {
        if (!session.live) return;
        if (event.type === 'subscribed' && event.sessionId === session.id) {
          setWatching(true);
          terminal.current?.reset();
          terminal.current?.configure({ readOnly: true, cols: event.cols, rows: event.rows });
          setNotice('');
        }
        if (event.type === 'control' && event.sessionId === session.id) {
          setControl(event);
          const owns = event.controllerId === client.clientId && !!event.leaseId;
          terminal.current?.configure(
            owns ? { readOnly: false } : { readOnly: true, cols: event.cols, rows: event.rows },
          );
          if (!owns) Keyboard.dismiss();
        }
        if (event.type === 'disconnected') {
          setControl(undefined);
          setWatching(false);
          subscribed.current = false;
          terminal.current?.configure({ readOnly: true });
        }
        if (event.type === 'output' && event.sessionId === session.id)
          terminal.current?.write(event.data, {
            allowResponses:
              client.hasControl(session.id) && (!event.replay || event.allowResponses === true),
          });
        if (event.type === 'error') setNotice(event.message);
      }),
    [client, session.id, session.live],
  );
  useEffect(() => {
    if (session.live && connected && ready.current && !subscribed.current) {
      subscribed.current = true;
      client.subscribeSession(session.id);
    }
    return () => {
      if (session.live && subscribed.current) client.unsubscribeSession(session.id);
      subscribed.current = false;
    };
  }, [connected, client, session.id, session.live]);
  function input(data: string) {
    if (session.live) {
      // Check the current lease, not a React closure: takeover can happen during a renderer frame.
      if (client.hasControl(session.id) && session.running !== false)
        client.sendInput(session.id, data);
    } else demo.current?.input(data);
  }
  function submit() {
    if (!draft.trim() || !canType) return;
    input(`${draft}\r`);
    setDraft('');
  }
  function dismissKeyboard() {
    composerInput.current?.blur();
    terminal.current?.blur();
    Keyboard.dismiss();
  }
  return (
    <KeyboardAvoidingView
      style={s.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // The application shell places the headerless Stack below the top safe-area inset.
      // The keyboard frame uses window coordinates; this view's layout starts at zero.
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <View style={s.header}>
        {!!session.live && !!hostCapabilities?.attention && (
          <IconButton
            name={session.muted ? 'notifications-off-outline' : 'notifications-outline'}
            label={session.muted ? 'Unmute session alerts' : 'Mute session alerts'}
            onPress={() => client.muteSession(session.id, !session.muted)}
          />
        )}
        <IconButton
          name="chevron-back"
          label="Back to sessions"
          onPress={() => {
            dismissKeyboard();
            onBack();
          }}
        />
        <Pressable style={s.headerTitle} accessible={false} onPress={dismissKeyboard}>
          <Text numberOfLines={1} style={s.name}>
            {session.name}
          </Text>
          <Text numberOfLines={1} style={s.meta}>
            <Text style={{ color: sessionAgentColor(session.agent) }}>{session.agent}</Text>
            {session.live ? ` · ${session.host}` : ' · Demo'}
          </Text>
        </Pressable>
        <IconButton
          name="folder-outline"
          label="Move session to a group"
          onPress={() => {
            dismissKeyboard();
            setGroupOpen(true);
          }}
        />
        <IconButton
          name="close"
          label="End session"
          onPress={() => {
            dismissKeyboard();
            setConfirmClose(true);
          }}
        />
      </View>
      <View style={s.path}>
        <View style={s.pathSummary}>
          <View style={s.pathLine}>
            <Text numberOfLines={1} style={s.pathText}>
              {session.cwd}
            </Text>
            {session.live && !connected ? (
              <Text style={s.status}>Offline</Text>
            ) : (
              <SessionStatusBadge
                status={session.status}
                readiness={session.readiness}
                hibernated={session.hibernated}
                currentAttention={session.currentAttention}
                source={session.statusSource}
                demo={!session.live}
                variant="plain"
              />
            )}
          </View>
          {!!showControl && (
            <Text style={s.controlLabel} numberOfLines={1}>
              {controlling
                ? '● You control this session'
                : control?.controllerId != null
                  ? '○ Viewing · another device is in control'
                  : '○ Viewing · you can take control'}
            </Text>
          )}
        </View>
        {!!showControl && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={controlling ? 'Release control' : 'Take control'}
            disabled={!watching}
            onPress={() => {
              if (controlling) client.releaseControl(session.id);
              else
                client.acquireControl(
                  session.id,
                  size.current.cols,
                  size.current.rows,
                  control?.controllerId != null,
                );
            }}
            style={s.controlButton}
          >
            <Text style={s.controlAction}>{controlling ? 'Release' : 'Take over'}</Text>
          </Pressable>
        )}
      </View>
      <View style={s.terminal}>
        <TerminalView
          ref={terminal}
          readOnly={!!session.live}
          interactive={!confirmClose && !groupOpen}
          onData={input}
          onResize={(cols, rows) => {
            size.current = { cols, rows };
            if (session.live && ready.current && client.hasControl(session.id))
              client.resizeSession(session.id, cols, rows);
          }}
          onReady={() => {
            ready.current = true;
            if (session.live) {
              if (connected && !subscribed.current) {
                subscribed.current = true;
                client.subscribeSession(session.id);
              }
            } else {
              demo.current = createDemoShell(
                text => terminal.current?.write(text),
                () => terminal.current?.reset(),
              );
              demo.current.start();
            }
          }}
        />
      </View>
      {!!notice && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss notice"
          onPress={() => setNotice('')}
          style={s.notice}
        >
          <Text style={s.noticeText}>{notice}</Text>
        </Pressable>
      )}
      <View style={s.toolbar}>
        <ScrollView
          horizontal
          style={s.keyScroll}
          contentContainerStyle={s.keys}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
        >
          {[
            { label: 'esc', value: '\u001b' },
            { label: 'tab', value: '\t' },
            { label: '↑', value: '\u001b[A' },
            { label: '↓', value: '\u001b[B' },
            { label: '←', value: '\u001b[D' },
            { label: '→', value: '\u001b[C' },
            { label: 'ctrl C', value: '\u0003' },
          ].map(key => (
            <Pressable
              key={key.label}
              accessibilityRole="button"
              accessibilityLabel={`Key ${key.label}`}
              disabled={!canType}
              onPress={() => input(key.value)}
              style={({ pressed }) => [s.key, !canType && s.inactive, pressed && s.keyPressed]}
            >
              <Text style={s.keyText} numberOfLines={1}>
                {key.label === 'ctrl C' ? '^C' : key.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hide keyboard"
          onPress={dismissKeyboard}
          style={({ pressed }) => [s.hideKeyboard, pressed && s.keyPressed]}
        >
          <Icon name="chevron-down" size={20} color={c.muted} />
        </Pressable>
      </View>
      <View style={s.composerArea}>
        <View style={[s.composer, composerFocused && s.composerFocused]}>
          <View style={s.composerRail} aria-hidden pointerEvents="none" />
          <Text aria-hidden style={s.promptSign}>
            {'>'}
          </Text>
          <TextInput
            ref={composerInput}
            accessibilityLabel="Terminal command"
            placeholder={!canType ? 'Take control to type' : 'Type a command'}
            placeholderTextColor={c.muted}
            selectionColor={c.accent}
            value={draft}
            editable={canType}
            onChangeText={setDraft}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            onSubmitEditing={submit}
            returnKeyType="send"
            submitBehavior="submit"
            autoCorrect={false}
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            keyboardAppearance="dark"
            style={s.draft}
          />
          <Pressable
            disabled={!draft.trim() || !canType}
            accessibilityRole="button"
            accessibilityLabel="Send"
            onPress={submit}
            style={({ pressed }) => [
              s.send,
              (!draft.trim() || !canType) && s.sendDisabled,
              pressed && s.sendPressed,
            ]}
          >
            <Icon name="arrow-up" size={20} color={c.accent} />
          </Pressable>
        </View>
      </View>
      <Modal
        visible={groupOpen}
        transparent
        animationType={Platform.OS !== 'web' && motionAllowed ? 'fade' : 'none'}
        onRequestClose={() => setGroupOpen(false)}
      >
        <SafeAreaProvider>
          <SafeAreaView style={s.groupOverlay}>
            <View style={s.groupSheet} accessibilityViewIsModal>
              <View style={s.groupHeader}>
                <Text style={s.name}>Move session</Text>
                <IconButton
                  name="close"
                  label="Close group picker"
                  onPress={() => setGroupOpen(false)}
                />
              </View>
              <Text style={common.body}>{groupPath(groups, session.groupId)}</Text>
              <ScrollView keyboardShouldPersistTaps="handled">
                <GroupPicker
                  groups={groups}
                  value={session.groupId ?? null}
                  disabled={!!session.live && !connected}
                  onChange={groupId => {
                    moveSession(session.id, groupId);
                    setGroupOpen(false);
                  }}
                />
              </ScrollView>
            </View>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
      <Modal
        visible={confirmClose}
        transparent
        animationType={Platform.OS !== 'web' && motionAllowed ? 'fade' : 'none'}
        onRequestClose={() => setConfirmClose(false)}
        accessibilityLabel="Confirm ending the session"
      >
        <ScrollView contentContainerStyle={s.confirm} keyboardShouldPersistTaps="handled">
          <View style={s.confirmContent} accessibilityViewIsModal>
            <Text style={s.name}>End the session?</Text>
            <Text style={common.body}>
              {session.live
                ? 'The terminal process will stop. Use the back arrow to leave it running.'
                : 'This removes the sample session from the list.'}
            </Text>
            <Button label="End session" onPress={onClose} />
            <Button label="Keep it open" secondary onPress={() => setConfirmClose(false)} />
          </View>
        </ScrollView>
      </Modal>
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, minHeight: 0, backgroundColor: c.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 2,
  },
  headerTitle: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: 'center', gap: 1 },
  name: { color: c.text, fontFamily: mono, fontSize: 13, fontWeight: '600', letterSpacing: -0.2 },
  meta: { color: c.faint, fontFamily: mono, fontSize: 10 },
  path: {
    paddingHorizontal: 10,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pathText: { fontFamily: mono, color: c.faint, fontSize: 11, flex: 1 },
  pathSummary: { flex: 1, minWidth: 0 },
  pathLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { color: c.orange, fontFamily: mono, fontSize: 11 },
  controlLabel: { color: c.accent, fontSize: 10, lineHeight: 15 },
  controlButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  controlAction: { color: c.accent, fontFamily: mono, fontSize: 11, fontWeight: '500' },
  inactive: { opacity: 0.4 },
  groupOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000099' },
  groupSheet: {
    maxHeight: '80%',
    backgroundColor: c.surface,
    padding: 18,
    borderTopWidth: 1,
    borderColor: c.border,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    gap: 14,
  },
  groupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  terminal: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  keyScroll: { flex: 1, minWidth: 0 },
  keys: { flexDirection: 'row', flexGrow: 1 },
  key: {
    flexGrow: 1,
    minWidth: 38,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: c.elevated },
  keyText: { color: c.muted, fontFamily: mono, fontSize: 12 },
  hideKeyboard: {
    width: 40,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  composerArea: {
    flexShrink: 0,
    paddingHorizontal: 10,
    paddingBottom: 6,
    backgroundColor: c.surface,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderLeftWidth: 3,
    borderLeftColor: c.accent,
    gap: 2,
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
  draft: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    color: c.text,
    paddingHorizontal: 6,
    paddingVertical: 6,
    fontSize: 16,
    fontFamily: mono,
  },
  send: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.35 },
  promptSign: { color: c.accent, fontFamily: mono, fontSize: 14, paddingLeft: 6 },
  sendPressed: { opacity: 0.75 },
  notice: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: c.surface,
  },
  noticeText: { color: c.muted, fontSize: 13, lineHeight: 20 },
  confirm: {
    flexGrow: 1,
    backgroundColor: `${c.background}F5`,
    justifyContent: 'center',
    padding: 28,
  },
  confirmContent: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    gap: 20,
  },
});
