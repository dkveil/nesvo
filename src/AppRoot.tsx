import React, { type PropsWithChildren } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import ConnectSheet from './ConnectSheet';
import { Button, common, Icon, IconButton, Pill } from './components';
import { AppStateProvider, openSession, useAppState } from './state/AppState';
import { colors as c, mono } from './theme';

const statusLabels = { attention: 'Wymaga uwagi', ready: 'Gotowa', done: 'Zakończona' };
const statusColors = { attention: c.orange, ready: c.accent, done: c.faint };
const tabPaths = { sessions: '/', hosts: '/hosts', settings: '/settings' } as const;
export type DashboardTab = keyof typeof tabPaths;

export function DashboardScreen({ tab }: { tab: DashboardTab }) {
  const {
    client,
    mode,
    sessions,
    connected,
    connecting,
    pairing,
    setConnectOpen,
    setCreateOpen,
    query,
    setQuery,
    filter,
    setFilter,
    notice,
    setNotice,
    connect,
    forget,
    resetDemo,
  } = useAppState();
  const visible = sessions.filter(
    (session) =>
      (filter === 'all' || session.status === 'attention') &&
      `${session.name} ${session.project} ${session.agent}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return (
    <View style={s.safe}>
      <View style={s.topbar}>
        <View style={s.logo}>
          <Icon name="terminal" color={c.accent} size={20} />
        </View>
        <Text style={s.wordmark}>
          pocket<Text style={{ fontWeight: '400', color: c.muted }}> sessions</Text>
        </Text>
        <View style={{ flex: 1 }} />
        <Pill
          label={
            mode === 'demo' ? 'DEMO' : connected ? 'ONLINE' : connecting ? 'ŁĄCZENIE' : 'OFFLINE'
          }
          color={mode === 'demo' ? c.muted : connected ? c.accent : c.orange}
        />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
        {tab === 'sessions' && (
          <>
            <View style={s.headingRow}>
              <View>
                <Text style={s.eyebrow}>TWOJA PRZESTRZEŃ ROBOCZA</Text>
                <Text style={s.heading}>
                  Sesje<Text style={s.count}> {sessions.length.toString().padStart(2, '0')}</Text>
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Nowa sesja"
                onPress={() => setCreateOpen(true)}
                style={s.add}
              >
                <Icon name="add" color={c.accentInk} size={27} />
              </Pressable>
            </View>
            {mode === 'demo' ? (
              <View style={s.demoBanner}>
                <View style={s.bannerTop}>
                  <Icon name="flask-outline" color={c.orange} size={18} />
                  <Text style={s.bannerTitle}>Rozejrzyj się. To tryb demo.</Text>
                </View>
                <Text style={s.bannerText}>
                  Sesje poniżej są przykładowe. Połącz komputer, żeby pracować na swoich plikach.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setConnectOpen(true)}
                  style={s.bannerLink}
                  accessibilityLabel="Połącz swój komputer"
                >
                  <Text style={s.link}>Połącz swój komputer</Text>
                  <Icon name="arrow-forward" size={16} color={c.accent} />
                </Pressable>
              </View>
            ) : (
              !connected && (
                <View style={common.card}>
                  <Text style={s.cardTitle}>
                    {connecting ? 'Łączenie z komputerem…' : 'Host jest rozłączony'}
                  </Text>
                  <Text style={common.body}>
                    Sesje pozostają na hoście, dopóki działa jego proces. Rozłączenie telefonu ich
                    nie zatrzymuje.
                  </Text>
                  <Button
                    label={pairing ? 'Połącz ponownie' : 'Sparuj host'}
                    onPress={() => (pairing ? void connect(pairing) : setConnectOpen(true))}
                    disabled={connecting}
                  />
                </View>
              )
            )}
            <View style={s.search}>
              <Icon name="search-outline" size={18} />
              <TextInput
                accessibilityLabel="Szukaj sesji"
                value={query}
                onChangeText={setQuery}
                placeholder="Znajdź sesję lub projekt"
                placeholderTextColor={c.faint}
                style={s.searchInput}
              />
            </View>
            <View style={s.filters}>
              {(['all', 'attention'] as const).map((f) => (
                <Pressable
                  key={f}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: filter === f }}
                  onPress={() => setFilter(f)}
                  style={[s.filter, filter === f && s.filterActive]}
                >
                  {f === 'attention' && <View style={s.attentionDot} />}
                  <Text style={[s.filterText, filter === f && { color: c.text }]}>
                    {f === 'all' ? 'Wszystkie' : 'Wymagają uwagi'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={s.sessionList}>
              {visible.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Otwórz sesję ${item.name}`}
                  onPress={() => openSession(item.id)}
                  style={({ pressed }) => [
                    s.sessionCard,
                    pressed && { backgroundColor: c.elevated },
                  ]}
                >
                  <View style={s.cardTop}>
                    <View
                      style={[
                        s.agentBadge,
                        {
                          backgroundColor:
                            item.agent === 'Claude'
                              ? '#ECA57D15'
                              : item.agent === 'Codex'
                                ? '#B9E69A12'
                                : c.elevated,
                        },
                      ]}
                    >
                      <Icon
                        name={
                          item.agent === 'Terminal'
                            ? 'terminal-outline'
                            : item.agent === 'Codex'
                              ? 'code-slash'
                              : 'sparkles-outline'
                        }
                        size={20}
                        color={
                          item.agent === 'Claude'
                            ? c.orange
                            : item.agent === 'Codex'
                              ? c.accent
                              : c.muted
                        }
                      />
                    </View>
                    <Text style={s.agentName}>{item.agent}</Text>
                    <View style={{ flex: 1 }} />
                    <Pill label={statusLabels[item.status]} color={statusColors[item.status]} />
                  </View>
                  <Text style={s.cardTitle}>{item.name}</Text>
                  <Text style={s.preview} numberOfLines={2}>
                    {item.preview}
                  </Text>
                  <View style={s.cardBottom}>
                    <Icon name="folder-outline" size={13} />
                    <Text style={s.project} numberOfLines={1}>
                      {item.project}
                    </Text>
                    <View style={{ flex: 1 }} />
                    <Icon
                      name={item.host.includes('VPS') ? 'server-outline' : 'laptop-outline'}
                      size={13}
                    />
                    <Text style={s.host} numberOfLines={1}>
                      {item.host}
                    </Text>
                    <Icon name="chevron-forward" size={14} />
                  </View>
                </Pressable>
              ))}
            </View>
            {!visible.length && (
              <View style={s.empty}>
                <Icon name="albums-outline" size={32} />
                <Text style={s.cardTitle}>
                  {sessions.length ? 'Brak pasujących sesji' : 'Miejsce na pierwszą sesję'}
                </Text>
                <Text style={common.body}>
                  {sessions.length
                    ? 'Zmień filtr lub wpisane hasło.'
                    : 'Utwórz terminal przyciskiem +. Uruchom w nim powłokę, Claude Code lub Codex.'}
                </Text>
              </View>
            )}
            <View style={s.footerNote}>
              <Icon name="lock-closed-outline" size={12} />
              <Text style={s.footnote}>
                {mode === 'demo'
                  ? 'Dane przykładowe · nic nie jest wysyłane do AI'
                  : 'Sesje na Twoim hoście · szyfrowana treść połączenia'}
              </Text>
            </View>
          </>
        )}
        {tab === 'hosts' && (
          <>
            <Text style={s.eyebrow}>POŁĄCZENIA</Text>
            <Text style={s.heading}>Twoje hosty</Text>
            <Text style={common.body}>
              Telefon jest pilotem. Cała praca dzieje się na Twoim komputerze lub serwerze.
            </Text>
            {pairing ? (
              <View style={common.card}>
                <View style={common.row}>
                  <Icon name="laptop-outline" size={24} color={c.accent} />
                  <Text style={s.cardTitle}>Sparowany host</Text>
                </View>
                <Text selectable style={s.hostAddress}>
                  {pairing.url}
                </Text>
                <Pill
                  label={connected ? 'Połączono' : 'Rozłączono'}
                  color={connected ? c.accent : c.orange}
                />
                <Button
                  label={connected ? 'Rozłącz' : 'Połącz'}
                  secondary
                  onPress={() => (connected ? client.disconnect() : void connect(pairing))}
                />
                <Button label="Zapomnij host" secondary onPress={() => void forget()} />
              </View>
            ) : (
              <View style={common.card}>
                <Icon name="link-outline" size={30} color={c.accent} />
                <Text style={s.cardTitle}>Połącz pierwszy komputer</Text>
                <Text style={common.body}>
                  Zeskanuj QR wygenerowany przez host. W tej wersji aplikacja zapamiętuje jeden
                  host.
                </Text>
              </View>
            )}
            <Button
              label="Sparuj komputer"
              icon="scan-outline"
              onPress={() => setConnectOpen(true)}
            />
            <View style={common.card}>
              <View style={common.row}>
                <Icon name="server-outline" />
                <Text style={s.cardTitle}>A co z VPS?</Text>
              </View>
              <Text style={common.body}>
                Możesz uruchomić host na serwerze i połączyć się przez prywatną sieć VPN.
                Bezpośredni klient SSH to kolejny etap rozwoju.
              </Text>
            </View>
          </>
        )}
        {tab === 'settings' && (
          <>
            <Text style={s.eyebrow}>POCKET SESSIONS / 0.1</Text>
            <Text style={s.heading}>Po Twojemu.</Text>
            <View style={common.card}>
              <Text style={s.cardTitle}>Podgląd aplikacji</Text>
              <Text style={common.body}>
                Sprawdź przykładowe rozmowy i terminal. Demo nie uruchamia narzędzi ani modeli AI.
              </Text>
              <Button
                label={mode === 'demo' ? 'Odtwórz sesje demo' : 'Włącz tryb demo'}
                secondary
                onPress={resetDemo}
              />
              {pairing && (
                <Button label="Wróć do swojego hosta" onPress={() => void connect(pairing)} />
              )}
            </View>
            <View style={common.card}>
              <Text style={s.cardTitle}>Twoje narzędzia i subskrypcje</Text>
              <Text style={common.body}>
                Uruchamiaj oryginalne CLI poleceniami claude lub codex. Logujesz się na swoim
                komputerze. Pocket Sessions nie wymaga klucza API do modeli i nie przechowuje ich
                tokenów logowania.
              </Text>
            </View>
            <View style={common.card}>
              <Text style={s.cardTitle}>Otwarte źródła</Text>
              <Text style={common.body}>
                Expo + React Native na telefonie. Rust i prawdziwe terminale PTY na komputerze.
                Projekt na licencji MIT.
              </Text>
              <Button
                label="Kod na GitHubie"
                icon="logo-github"
                secondary
                onPress={() => void Linking.openURL('https://github.com/dkveil/pocket-sessions')}
              />
            </View>
            <Text style={s.footnote}>
              Wczesny prototyp. Widok rozmów jest demonstracyjny. Sesje terminala działają po
              połączeniu z hostem.
            </Text>
          </>
        )}
      </ScrollView>
      {!!notice && (
        <Pressable
          onPress={() => setNotice('')}
          accessibilityRole="button"
          accessibilityLabel="Ukryj komunikat"
          style={s.notice}
        >
          <Text style={s.noticeText}>{notice}</Text>
          <Icon name="close" size={16} color={c.orange} />
        </Pressable>
      )}
      <View style={s.nav}>
        {(
          [
            { id: 'sessions', icon: 'albums-outline', label: 'Sesje' },
            { id: 'hosts', icon: 'desktop-outline', label: 'Hosty' },
            { id: 'settings', icon: 'options-outline', label: 'Ustawienia' },
          ] as const
        ).map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === item.id }}
            accessibilityLabel={item.label}
            onPress={() => router.navigate(tabPaths[item.id])}
            style={s.navItem}
          >
            <Icon name={item.icon} size={22} color={tab === item.id ? c.accent : c.faint} />
            <Text style={[s.navLabel, tab === item.id && { color: c.accent }]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function AppModals() {
  const {
    connectOpen,
    setConnectOpen,
    connect,
    createOpen,
    setCreateOpen,
    mode,
    sessionName,
    setSessionName,
    create,
    connected,
  } = useAppState();
  return (
    <>
      {connectOpen && (
        <ConnectSheet
          onClose={() => setConnectOpen(false)}
          onConnect={(value) => void connect(value)}
        />
      )}
      <Modal
        visible={createOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setCreateOpen(false)}
      >
        <KeyboardAvoidingView
          style={s.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.sheet}>
            <View style={s.headingRow}>
              <Text style={common.heading}>Nowa sesja</Text>
              <IconButton
                name="close"
                label="Anuluj nową sesję"
                onPress={() => setCreateOpen(false)}
              />
            </View>
            <Pill label={mode === 'demo' ? 'Tryb demo' : 'Terminal na hoście'} />
            <Text style={common.body}>
              {mode === 'demo'
                ? 'Utwórz przykładowy terminal i przetestuj interfejs.'
                : 'Otwórz powłokę w katalogu skonfigurowanym na hoście. Możesz uruchomić w niej swoje CLI.'}
            </Text>
            <TextInput
              accessibilityLabel="Nazwa sesji"
              autoFocus
              placeholder="np. Poprawki w aplikacji"
              placeholderTextColor={c.faint}
              value={sessionName}
              onChangeText={setSessionName}
              maxLength={80}
              onSubmitEditing={create}
              style={common.input}
            />
            <Button
              label="Utwórz sesję"
              icon="add"
              onPress={create}
              disabled={!sessionName.trim() || (mode === 'live' && !connected)}
            />
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

export default function AppRoot({ children }: PropsWithChildren) {
  return (
    <AppStateProvider>
      <SafeAreaProvider style={s.outer}>
        <View style={s.frame}>
          <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
            <StatusBar style="light" />
            {children}
            <AppModals />
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </AppStateProvider>
  );
}

const s = StyleSheet.create({
  outer: { flex: 1, backgroundColor: '#080A0B' },
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
    backgroundColor: c.background,
  },
  safe: { flex: 1, backgroundColor: c.background },
  topbar: {
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logo: {
    height: 34,
    width: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#B9E69A35',
    backgroundColor: '#B9E69A0A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: { color: c.text, fontSize: 16, fontWeight: '700', letterSpacing: -0.4 },
  content: { paddingHorizontal: 24, paddingBottom: 30, gap: 20 },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  eyebrow: { color: c.faint, fontSize: 9, fontWeight: '700', letterSpacing: 1.8 },
  heading: { color: c.text, fontSize: 36, lineHeight: 45, fontWeight: '700', letterSpacing: -1.5 },
  count: { color: c.faint, fontWeight: '400', fontSize: 25 },
  add: {
    width: 48,
    height: 48,
    backgroundColor: c.accent,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  demoBanner: {
    backgroundColor: '#ECA57D08',
    borderColor: '#ECA57D25',
    borderWidth: 1,
    borderRadius: 14,
    padding: 15,
    gap: 9,
  },
  bannerTop: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  bannerTitle: { color: c.orange, fontSize: 12, fontWeight: '600' },
  bannerText: { color: c.muted, fontSize: 12, lineHeight: 19 },
  bannerLink: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 8 },
  link: { color: c.accent, fontSize: 12, fontWeight: '600' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: c.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    gap: 10,
  },
  searchInput: { flex: 1, color: c.text, fontSize: 13, minHeight: 46 },
  filters: { flexDirection: 'row', gap: 7, marginTop: -6, marginBottom: -2 },
  filter: {
    flexDirection: 'row',
    gap: 7,
    minHeight: 36,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  filterActive: { backgroundColor: c.elevated },
  filterText: { color: c.faint, fontSize: 11, fontWeight: '600' },
  attentionDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.orange },
  sessionList: { gap: 12 },
  sessionCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 16,
    padding: 17,
    gap: 11,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  agentBadge: {
    height: 32,
    width: 32,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  agentName: { color: c.muted, fontSize: 12, fontWeight: '600' },
  cardTitle: { color: c.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  preview: { color: c.muted, fontSize: 12, lineHeight: 19 },
  cardBottom: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: c.border,
    paddingTop: 12,
    marginTop: 2,
  },
  project: { color: c.muted, fontSize: 10, fontFamily: mono, maxWidth: '47%' },
  host: { color: c.faint, fontSize: 10, maxWidth: '32%' },
  hostAddress: { color: c.muted, fontFamily: mono, fontSize: 13 },
  footerNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  footnote: { color: c.faint, fontSize: 10, lineHeight: 17 },
  nav: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
    paddingTop: 10,
    paddingBottom: 8,
  },
  navItem: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', gap: 5 },
  navLabel: { fontSize: 10, color: c.faint, fontWeight: '600' },
  empty: { padding: 24, alignItems: 'center', gap: 14 },
  notice: {
    marginHorizontal: 16,
    marginBottom: 10,
    backgroundColor: '#ECA57D15',
    padding: 12,
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  noticeText: { flex: 1, color: c.orange, fontSize: 12, lineHeight: 18 },
  overlay: { flex: 1, backgroundColor: '#000000AA', justifyContent: 'center', padding: 24 },
  sheet: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    padding: 24,
    gap: 20,
    borderRadius: 24,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
});
