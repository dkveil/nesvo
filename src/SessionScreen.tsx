import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { HostClient } from './connection/client';
import TerminalView, { type TerminalHandle } from './terminal/TerminalView';
import { createDemoShell, demoConversations, type DemoSession } from './demo';
import { Button, common, Icon, IconButton, Pill } from './components';
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
        'To podgląd interfejsu. Prompt nie został wysłany do modelu. Połącz host i uruchom claude lub codex w terminalu.',
      );
    else input(`${draft}\r`);
    setDraft('');
  }
  return (
    <KeyboardAvoidingView
      style={s.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={s.header}>
        <IconButton name="chevron-back" label="Wróć do sesji" onPress={onBack} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={s.name}>
            {session.name}
          </Text>
          <Text numberOfLines={1} style={s.meta}>
            {session.live ? session.host : `DEMO · ${session.host}`}
          </Text>
        </View>
        <IconButton
          name="close-circle-outline"
          label="Zakończ sesję"
          onPress={() => setConfirmClose(true)}
        />
      </View>
      <View style={s.path}>
        <Icon name="folder-outline" size={14} />
        <Text numberOfLines={1} style={s.pathText}>
          {session.cwd}
        </Text>
        <Pill
          label={
            session.live
              ? connected
                ? session.running === false
                  ? 'Zakończona'
                  : 'Połączono'
                : 'Offline'
              : 'Demo'
          }
          color={session.live && !connected ? c.orange : c.accent}
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
              <Icon
                name={value === 'terminal' ? 'terminal-outline' : 'chatbubble-outline'}
                color={tab === value ? c.text : c.faint}
                size={16}
              />
              <Text style={[s.tabText, tab === value && { color: c.text }]}>
                {value === 'terminal' ? 'Terminal' : 'Rozmowa'}
              </Text>
            </Pressable>
          ))}
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
        <ScrollView contentContainerStyle={s.messages}>
          <Text style={s.example}>PRZYKŁADOWA ROZMOWA · BEZ POŁĄCZENIA Z AI</Text>
          {(demoConversations[session.id] ?? []).map((message, i) => (
            <View key={i} style={[s.message, message.role === 'user' && s.userMessage]}>
              <Text style={s.messageRole}>
                {message.role === 'user'
                  ? 'TY'
                  : message.role === 'system'
                    ? 'PODGLĄD'
                    : session.agent.toUpperCase()}
              </Text>
              <Text selectable style={s.messageText}>
                {message.content}
              </Text>
            </View>
          ))}
          <View style={s.demoHint}>
            <Icon name="information-circle-outline" size={18} color={c.orange} />
            <Text style={s.hintText}>
              Widok rozmowy pokazuje kierunek produktu. Pierwsza wersja obsługuje prawdziwe sesje w
              zakładce Terminal.
            </Text>
          </View>
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
              style={({ pressed }) => [s.key, pressed && { backgroundColor: c.border }]}
            >
              <Text style={s.keyText}>{key.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={s.composer}>
        <TextInput
          accessibilityLabel={tab === 'terminal' ? 'Polecenie terminala' : 'Przykładowy prompt'}
          placeholder={tab === 'terminal' ? 'Wpisz polecenie…' : 'Napisz prompt…'}
          placeholderTextColor={c.faint}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submit}
          returnKeyType="send"
          blurOnSubmit={false}
          autoCorrect={false}
          autoCapitalize="none"
          style={s.draft}
        />
        <Pressable
          disabled={!draft.trim()}
          accessibilityRole="button"
          accessibilityLabel="Wyślij"
          onPress={submit}
          style={[s.send, !draft.trim() && { opacity: 0.35 }]}
        >
          <Icon name="arrow-up" size={20} color={c.accentInk} />
        </Pressable>
      </View>
      {confirmClose && (
        <View style={s.confirm}>
          <Text style={s.name}>Zakończyć sesję?</Text>
          <Text style={common.body}>
            {session.live
              ? 'Proces terminala zostanie zatrzymany. Użyj strzałki wstecz, aby pozostawić go działającego.'
              : 'Usuniesz tę przykładową sesję z listy.'}
          </Text>
          <Button label="Zakończ sesję" onPress={onClose} />
          <Button label="Zostaw otwartą" secondary onPress={() => setConfirmClose(false)} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 4,
    paddingVertical: 8,
  },
  name: { color: c.text, fontSize: 17, fontWeight: '600' },
  meta: { color: c.faint, fontSize: 11, marginTop: 4 },
  path: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pathText: { fontFamily: mono, color: c.muted, fontSize: 11, flex: 1 },
  tabs: { flexDirection: 'row', marginHorizontal: 20, borderBottomWidth: 1, borderColor: c.border },
  tab: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderBottomWidth: 2,
    borderColor: 'transparent',
  },
  selectedTab: { borderColor: c.accent },
  tabText: { color: c.faint, fontSize: 13, fontWeight: '600' },
  terminal: { flex: 1, minHeight: 100, marginHorizontal: 4 },
  messages: { padding: 20, gap: 22 },
  example: { fontSize: 9, color: c.faint, letterSpacing: 0.9 },
  message: { gap: 10 },
  userMessage: { padding: 16, borderRadius: 14, backgroundColor: c.surface },
  messageRole: { color: c.accent, fontSize: 10, letterSpacing: 1, fontWeight: '700' },
  messageText: { color: c.text, fontSize: 15, lineHeight: 24 },
  demoHint: {
    flexDirection: 'row',
    gap: 10,
    padding: 14,
    backgroundColor: '#ECA57D0D',
    borderRadius: 12,
  },
  hintText: { flex: 1, color: c.orange, fontSize: 12, lineHeight: 19 },
  keys: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 5,
    borderTopWidth: 1,
    borderColor: c.border,
  },
  key: {
    flex: 1,
    backgroundColor: c.surface,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyText: { color: c.muted, fontFamily: mono, fontSize: 12 },
  composer: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 10 },
  draft: {
    flex: 1,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    minHeight: 48,
    color: c.text,
    padding: 12,
    fontSize: 14,
  },
  send: {
    width: 44,
    height: 44,
    backgroundColor: c.accent,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: { padding: 12, marginHorizontal: 12, borderRadius: 10, backgroundColor: '#ECA57D15' },
  noticeText: { color: c.orange, fontSize: 12, lineHeight: 19 },
  confirm: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#101214F5',
    justifyContent: 'center',
    padding: 28,
    gap: 20,
  },
});
