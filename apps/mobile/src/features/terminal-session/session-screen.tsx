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
  demoConversations,
  type Session,
  SessionStatusBadge,
  sessionStatusDetail,
} from '@entities/session';
import { useWorkspace } from '@entities/workspace';

import type { HostClient, SessionControl } from '@shared/api/host';
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
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'conversation' | 'terminal'>('terminal');
  const [draft, setDraft] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [control, setControl] = useState<SessionControl | undefined>(() =>
    client.getControl(session.id),
  );
  const [watching, setWatching] = useState(false);
  const { groups, moveSession } = useWorkspace();
  const controlling =
    !!session.live && connected && control?.controllerId === client.clientId && !!control?.leaseId;
  const canType = !session.live || (controlling && session.running !== false);
  const terminal = useRef<TerminalHandle>(null);
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
    if (tab === 'conversation')
      setNotice(
        'To podgląd. Wiadomość nie została wysłana. Połącz host i otwórz agenta w terminalu.',
      );
    else input(`${draft}\r`);
    setDraft('');
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
        <IconButton
          name="chevron-back"
          label="Wróć do sesji"
          onPress={() => {
            Keyboard.dismiss();
            onBack();
          }}
        />
        <View style={s.headerTitle}>
          <Text numberOfLines={1} style={s.name}>
            {session.name}
          </Text>
          <Text numberOfLines={1} style={s.meta}>
            {session.live ? session.host : `${session.agent} · Demo`}
          </Text>
        </View>
        <IconButton
          name="folder-outline"
          label="Przenieś sesję do grupy"
          onPress={() => {
            Keyboard.dismiss();
            setGroupOpen(true);
          }}
        />
        <IconButton
          name="close"
          label="Zakończ sesję"
          onPress={() => {
            Keyboard.dismiss();
            setConfirmClose(true);
          }}
        />
      </View>
      {!session.live && session.agent !== 'Terminal' && (
        <View style={s.tabs}>
          {(['terminal', 'conversation'] as const).map(value => (
            <Pressable
              key={value}
              accessibilityRole="tab"
              aria-selected={tab === value}
              accessibilityState={{ selected: tab === value }}
              onPress={() => {
                ready.current = false;
                setTab(value);
              }}
              style={[s.tab, tab === value && s.selectedTab]}
            >
              <Text style={[s.tabText, tab === value && s.activeTabText]}>
                {value === 'terminal' ? 'Terminal' : 'Rozmowa'}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {tab === 'terminal' && (
        <View style={s.path}>
          <Text numberOfLines={1} style={s.pathText}>
            {session.cwd}
          </Text>
          {session.live && !connected ? (
            <Text style={s.status}>Offline</Text>
          ) : (
            <SessionStatusBadge
              status={session.status}
              source={session.statusSource}
              demo={!session.live}
            />
          )}
        </View>
      )}
      {!!session.live && !!connected && (
        <Text style={s.stateDetail}>
          {sessionStatusDetail(session.status, session.statusSource)}
        </Text>
      )}
      {!!session.live && !!connected && session.running !== false && (
        <View style={s.controlBar}>
          <Text style={s.controlLabel}>
            {controlling
              ? 'Sterujesz z tego urządzenia'
              : control?.controllerId != null
                ? 'Podgląd · steruje inne urządzenie'
                : 'Podgląd · terminal bez sterowania'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={controlling ? 'Oddaj sterowanie' : 'Przejmij sterowanie'}
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
            <Text style={s.controlAction}>{controlling ? 'Oddaj' : 'Przejmij sterowanie'}</Text>
          </Pressable>
        </View>
      )}
      {tab === 'terminal' ? (
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
      ) : (
        <ScrollView
          style={s.conversation}
          contentContainerStyle={s.messages}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.example}>Przykładowa rozmowa</Text>
          {(demoConversations[session.id] ?? [])
            .filter(message => message.role !== 'system')
            .map((message, i) => (
              <View
                key={i}
                accessibilityLabel={message.role === 'user' ? 'Twoja wiadomość' : session.agent}
                style={[s.message, message.role === 'user' && s.userMessage]}
              >
                <Text selectable style={s.messageText}>
                  {message.content}
                </Text>
              </View>
            ))}
        </ScrollView>
      )}
      {!!notice && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ukryj informację"
          onPress={() => setNotice('')}
          style={s.notice}
        >
          <Text style={s.noticeText}>{notice}</Text>
        </Pressable>
      )}
      {tab === 'terminal' && (
        <View style={s.keys}>
          {[
            { label: 'esc', value: '\u001b' },
            { label: 'ctrl C', value: '\u0003' },
            { label: 'tab', value: '\t' },
            { label: '↑', value: '\u001b[A' },
            { label: '↓', value: '\u001b[B' },
            { label: '←', value: '\u001b[D' },
            { label: '→', value: '\u001b[C' },
          ].map(key => (
            <Pressable
              key={key.label}
              accessibilityRole="button"
              accessibilityLabel={`Klawisz ${key.label}`}
              disabled={!canType}
              onPress={() => input(key.value)}
              style={({ pressed }) => [s.key, !canType && s.inactive, pressed && s.keyPressed]}
            >
              <Text style={s.keyText} numberOfLines={1}>
                {key.label === 'ctrl C' ? '^C' : key.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={s.composerArea}>
        <View style={[s.composer, composerFocused && s.composerFocused]}>
          <View style={s.composerRail} aria-hidden pointerEvents="none" />
          <Text aria-hidden style={s.promptSign}>
            {tab === 'terminal' ? '>' : '+'}
          </Text>
          <TextInput
            accessibilityLabel={tab === 'terminal' ? 'Polecenie terminala' : 'Przykładowy prompt'}
            placeholder={
              !canType
                ? 'Przejmij sterowanie, aby pisać'
                : tab === 'terminal'
                  ? 'Wpisz polecenie'
                  : 'Wiadomość'
            }
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
            accessibilityLabel="Wyślij"
            onPress={submit}
            style={({ pressed }) => [
              s.send,
              (!draft.trim() || !canType) && s.sendDisabled,
              pressed && s.sendPressed,
            ]}
          >
            <Icon name="arrow-up" size={22} color={c.accentInk} />
          </Pressable>
        </View>
        {tab === 'conversation' && (
          <Text style={s.composerHint}>Demo · wiadomości nie są wysyłane do AI</Text>
        )}
      </View>
      <Modal
        visible={groupOpen}
        transparent
        animationType="none"
        onRequestClose={() => setGroupOpen(false)}
      >
        <SafeAreaProvider>
          <SafeAreaView style={s.groupOverlay}>
            <View style={s.groupSheet} accessibilityViewIsModal>
              <View style={s.groupHeader}>
                <Text style={s.name}>Przenieś sesję</Text>
                <IconButton
                  name="close"
                  label="Zamknij wybór grupy"
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
        animationType="none"
        onRequestClose={() => setConfirmClose(false)}
        accessibilityLabel="Potwierdzenie zakończenia sesji"
      >
        <ScrollView contentContainerStyle={s.confirm} keyboardShouldPersistTaps="handled">
          <View style={s.confirmContent} accessibilityViewIsModal>
            <Text style={s.name}>Zakończyć sesję?</Text>
            <Text style={common.body}>
              {session.live
                ? 'Proces terminala zostanie zatrzymany. Użyj strzałki wstecz, aby pozostawić go działającego.'
                : 'Usuniesz tę przykładową sesję z listy.'}
            </Text>
            <Button label="Zakończ sesję" onPress={onClose} />
            <Button label="Zostaw otwartą" secondary onPress={() => setConfirmClose(false)} />
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
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 8,
  },
  headerTitle: { flex: 1, alignItems: 'flex-start', gap: 3 },
  name: { color: c.text, fontFamily: mono, fontSize: 13, fontWeight: '600', letterSpacing: -0.2 },
  meta: { color: c.faint, fontFamily: mono, fontSize: 10 },
  path: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pathText: { fontFamily: mono, color: c.faint, fontSize: 11, flex: 1 },
  status: { color: c.orange, fontFamily: mono, fontSize: 11 },
  stateDetail: {
    color: c.faint,
    fontFamily: mono,
    fontSize: 9,
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  controlBar: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    paddingHorizontal: 14,
    marginBottom: 6,
  },
  controlLabel: { color: c.faint, fontSize: 11, lineHeight: 17, flex: 1 },
  controlButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
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
  tabs: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: c.surface,
    borderRadius: 4,
    padding: 3,
    marginBottom: 4,
    marginLeft: 14,
  },
  tab: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 3 },
  selectedTab: { backgroundColor: c.elevated },
  tabText: { color: c.muted, fontFamily: mono, fontSize: 11, fontWeight: '500' },
  activeTabText: { color: c.accent },
  terminal: {
    flex: 1,
    minHeight: 0,
    marginHorizontal: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    borderRadius: 4,
    overflow: 'hidden',
  },
  conversation: { flex: 1, minHeight: 0 },
  messages: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 32, gap: 30 },
  example: { color: c.faint, fontSize: 11, alignSelf: 'center', marginBottom: -4 },
  message: { alignSelf: 'flex-start', width: '100%' },
  userMessage: {
    alignSelf: 'flex-end',
    width: 'auto',
    maxWidth: '88%',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 6,
    backgroundColor: c.elevated,
  },
  messageText: { color: c.text, fontSize: 16, lineHeight: 26 },
  keys: { flexDirection: 'row', paddingHorizontal: 10, paddingTop: 6, gap: 3 },
  key: {
    flex: 1,
    minHeight: 44,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: c.elevated },
  keyText: { color: c.muted, fontFamily: mono, fontSize: 12 },
  composerArea: { flexShrink: 0, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 10, gap: 7 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderLeftWidth: 3,
    borderLeftColor: c.accent,
    padding: 3,
    gap: 4,
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
    minHeight: 46,
    color: c.text,
    paddingHorizontal: 6,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: mono,
  },
  send: {
    width: 44,
    height: 44,
    backgroundColor: c.accent,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.35 },
  promptSign: { color: c.accent, fontFamily: mono, fontSize: 18, paddingLeft: 9 },
  sendPressed: { opacity: 0.75 },
  composerHint: { color: c.faint, fontSize: 10, textAlign: 'center' },
  notice: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 16,
    borderRadius: 6,
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
