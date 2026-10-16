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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { HostClient } from './connection/client';
import TerminalView, { type TerminalHandle } from './terminal/TerminalView';
import { createDemoShell, demoConversations, type DemoSession } from './demo';
import { Button, common, Icon, IconButton } from './components';
import { colors as c, mono } from './theme';

export type Session = DemoSession & { live?: boolean; running?: boolean };
export default function SessionScreen({
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
  const [tab, setTab] = useState<'conversation' | 'terminal'>(
    session.live || session.agent === 'Terminal' ? 'terminal' : 'conversation',
  );
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const terminal = useRef<TerminalHandle>(null);
  const size = useRef({ cols: 80, rows: 24 });
  const ready = useRef(false);
  const demo = useRef<ReturnType<typeof createDemoShell> | null>(null);
  useEffect(
    () =>
      client.subscribe((event) => {
        if (!session.live) return;
        if (event.type === 'attached' && event.sessionId === session.id) {
          terminal.current?.reset();
          setNotice('');
        }
        if (event.type === 'output' && event.sessionId === session.id)
          terminal.current?.write(event.data);
        if (event.type === 'error') setNotice(event.message);
      }),
    [client, session.id, session.live],
  );
  useEffect(() => {
    if (session.live && connected && ready.current)
      client.attachSession(session.id, size.current.cols, size.current.rows);
  }, [connected, client, session.id, session.live]);
  function input(data: string) {
    if (session.live) {
      if (connected && session.running !== false) client.sendInput(session.id, data);
      else setNotice('Host jest rozłączony lub sesja zakończona. Polecenie nie zostało wysłane.');
    } else demo.current?.input(data);
  }
  function submit() {
    if (!draft.trim()) return;
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
      // AppRoot places this headerless Stack below the top safe-area inset.
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
          {(['conversation', 'terminal'] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="tab"
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
          <Text style={s.status}>
            {session.live
              ? connected
                ? session.running === false
                  ? 'Zakończona'
                  : 'Połączono'
                : 'Offline'
              : 'Demo'}
          </Text>
        </View>
      )}
      {tab === 'terminal' ? (
        <View style={s.terminal}>
          <TerminalView
            ref={terminal}
            onData={input}
            onResize={(cols, rows) => {
              size.current = { cols, rows };
              if (session.live && ready.current && connected)
                client.resizeSession(session.id, cols, rows);
            }}
            onReady={() => {
              ready.current = true;
              if (session.live) {
                if (connected)
                  client.attachSession(session.id, size.current.cols, size.current.rows);
              } else {
                demo.current = createDemoShell(
                  (text) => terminal.current?.write(text),
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
            .filter((message) => message.role !== 'system')
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
          ].map((key) => (
            <Pressable
              key={key.label}
              accessibilityRole="button"
              accessibilityLabel={`Klawisz ${key.label}`}
              onPress={() => input(key.value)}
              style={({ pressed }) => [s.key, pressed && s.keyPressed]}
            >
              <Text style={s.keyText}>{key.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={s.composerArea}>
        <View style={s.composer}>
          <TextInput
            accessibilityLabel={tab === 'terminal' ? 'Polecenie terminala' : 'Przykładowy prompt'}
            placeholder={tab === 'terminal' ? 'Wpisz polecenie' : 'Wiadomość'}
            placeholderTextColor={c.muted}
            value={draft}
            onChangeText={setDraft}
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
            disabled={!draft.trim()}
            accessibilityRole="button"
            accessibilityLabel="Wyślij"
            onPress={submit}
            style={({ pressed }) => [
              s.send,
              !draft.trim() && s.sendDisabled,
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
  headerTitle: { flex: 1, alignItems: 'center', gap: 3 },
  name: { color: c.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  meta: { color: c.faint, fontSize: 12 },
  path: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pathText: { fontFamily: mono, color: c.faint, fontSize: 11, flex: 1 },
  status: { color: c.muted, fontSize: 11 },
  tabs: {
    flexDirection: 'row',
    alignSelf: 'center',
    backgroundColor: c.surface,
    borderRadius: 24,
    padding: 3,
    marginBottom: 4,
  },
  tab: { minHeight: 40, paddingHorizontal: 22, justifyContent: 'center', borderRadius: 21 },
  selectedTab: { backgroundColor: c.elevated },
  tabText: { color: c.muted, fontSize: 13, fontWeight: '500' },
  activeTabText: { color: c.text },
  terminal: { flex: 1, minHeight: 0, marginHorizontal: 8 },
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
    borderRadius: 22,
    backgroundColor: c.elevated,
  },
  messageText: { color: c.text, fontSize: 16, lineHeight: 26 },
  keys: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 4, gap: 3 },
  key: { flex: 1, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  keyPressed: { backgroundColor: c.elevated },
  keyText: { color: c.muted, fontFamily: mono, fontSize: 12 },
  composerArea: { flexShrink: 0, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 12, gap: 9 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 30,
    padding: 7,
    gap: 4,
  },
  draft: {
    flex: 1,
    minHeight: 46,
    color: c.text,
    paddingHorizontal: 13,
    paddingVertical: 10,
    fontSize: 16,
  },
  send: {
    width: 44,
    height: 44,
    backgroundColor: c.accent,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { opacity: 0.35 },
  sendPressed: { opacity: 0.75 },
  composerHint: { color: c.faint, fontSize: 10, textAlign: 'center' },
  notice: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 16,
    borderRadius: 16,
    backgroundColor: c.surface,
  },
  noticeText: { color: c.muted, fontSize: 13, lineHeight: 20 },
  confirm: {
    flexGrow: 1,
    backgroundColor: '#0B0B0BF5',
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
