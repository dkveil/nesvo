import React, { useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, common, Icon, IconButton } from './components';
import { openSession, useAppState } from './state/AppState';
import { colors as c, mono } from './theme';

const navigation = [
  { id: 'sessions', path: '/', icon: 'chatbubbles-outline', label: 'Sesje' },
  { id: 'hosts', path: '/hosts', icon: 'desktop-outline', label: 'Komputery' },
  { id: 'settings', path: '/settings', icon: 'settings-outline', label: 'Ustawienia' },
] as const;
export type DashboardTab = (typeof navigation)[number]['id'];

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
  const [menuOpen, setMenuOpen] = useState(false);
  const connectionLabel =
    mode === 'demo'
      ? 'Tryb demo'
      : connected
        ? 'Połączono'
        : connecting
          ? 'Łączenie…'
          : 'Rozłączono';
  const visible = sessions.filter(
    (session) =>
      (filter === 'all' || session.status === 'attention') &&
      `${session.name} ${session.project} ${session.agent}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );

  return (
    <View style={s.page}>
      <View style={s.header}>
        <IconButton name="menu-outline" label="Otwórz menu" onPress={() => setMenuOpen(true)} />
        <Text style={s.headerTitle}>{navigation.find((item) => item.id === tab)?.label}</Text>
        <IconButton name="create-outline" label="Nowa sesja" onPress={() => setCreateOpen(true)} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
        {tab === 'sessions' && (
          <>
            <View style={s.intro}>
              <Text style={s.title}>Nad czym pracujesz?</Text>
              <Text style={s.subtitle}>Wróć do sesji lub zacznij coś nowego.</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                mode === 'demo' ? 'Połącz swój komputer' : 'Zarządzaj połączeniem'
              }
              onPress={() => (mode === 'demo' ? setConnectOpen(true) : router.navigate('/hosts'))}
              style={({ pressed }) => [s.connection, pressed && s.pressed]}
            >
              <Icon name={mode === 'demo' ? 'link-outline' : 'laptop-outline'} size={20} />
              <View style={s.grow}>
                <Text style={s.connectionTitle}>
                  {mode === 'demo'
                    ? 'Połącz komputer'
                    : pairing
                      ? new URL(pairing.url).hostname
                      : 'Połącz komputer'}
                </Text>
                <Text style={s.meta}>
                  {mode === 'demo' ? 'Tryb demo · sesje poniżej są przykładowe' : connectionLabel}
                </Text>
              </View>
              <Icon name="chevron-forward" size={16} />
            </Pressable>
            {mode === 'live' && !connected && (
              <View style={s.reconnect}>
                <Text style={common.body}>Sesje czekają na komputerze, dopóki działa host.</Text>
                <Button
                  label={pairing ? 'Połącz ponownie' : 'Sparuj komputer'}
                  disabled={connecting}
                  onPress={() => (pairing ? void connect(pairing) : setConnectOpen(true))}
                />
              </View>
            )}
            <View style={s.search}>
              <Icon name="search-outline" size={18} />
              <TextInput
                accessibilityLabel="Szukaj sesji"
                value={query}
                onChangeText={setQuery}
                placeholder="Szukaj sesji"
                placeholderTextColor={c.faint}
                style={s.searchInput}
              />
              {!!query && (
                <IconButton
                  name="close"
                  label="Wyczyść wyszukiwanie"
                  onPress={() => setQuery('')}
                />
              )}
            </View>
            <View style={s.filters}>
              {(['all', 'attention'] as const).map((value) => (
                <Pressable
                  key={value}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: filter === value }}
                  onPress={() => setFilter(value)}
                  style={[s.filter, filter === value && s.activeFilter]}
                >
                  <Text style={[s.filterText, filter === value && s.activeFilterText]}>
                    {value === 'all' ? 'Wszystkie' : 'Wymagają uwagi'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={s.sessionList}>
              {visible.map((session) => (
                <Pressable
                  key={session.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Otwórz sesję ${session.name}`}
                  onPress={() => openSession(session.id)}
                  style={({ pressed }) => [s.sessionRow, pressed && s.pressed]}
                >
                  <View style={s.sessionIcon}>
                    <Icon
                      name={
                        session.agent === 'Terminal' ? 'terminal-outline' : 'chatbubble-outline'
                      }
                      color={c.muted}
                      size={21}
                    />
                  </View>
                  <View style={s.grow}>
                    <View style={s.sessionTitleRow}>
                      <Text style={s.sessionTitle} numberOfLines={1}>
                        {session.name}
                      </Text>
                      {session.status === 'attention' && (
                        <View accessibilityLabel="Wymaga uwagi" style={s.attentionDot} />
                      )}
                    </View>
                    <Text style={s.sessionPreview} numberOfLines={1}>
                      {session.preview}
                    </Text>
                    <Text style={s.meta} numberOfLines={1}>
                      {session.agent} · {session.project}
                      {session.status === 'done' ? ' · zakończona' : ''}
                    </Text>
                  </View>
                </Pressable>
              ))}
              {!visible.length && (
                <View style={s.empty}>
                  <Icon name="chatbubble-outline" size={28} />
                  <Text style={s.sectionTitle}>
                    {sessions.length ? 'Brak pasujących sesji' : 'Miejsce na pierwszą sesję'}
                  </Text>
                  <Text style={[common.body, s.center]}>
                    {sessions.length
                      ? 'Zmień filtr lub wpisane hasło.'
                      : 'Otwórz nową sesję, żeby zacząć pracę na komputerze.'}
                  </Text>
                </View>
              )}
            </View>
          </>
        )}
        {tab === 'hosts' && (
          <>
            <View style={s.intro}>
              <Text style={s.title}>Twój komputer.{'\n'}Zawsze pod ręką.</Text>
              <Text style={s.subtitle}>
                Praca zostaje na komputerze. Ty możesz wrócić do niej z telefonu.
              </Text>
            </View>
            {pairing ? (
              <View style={s.settingsGroup}>
                <View style={common.row}>
                  <Icon name="laptop-outline" size={24} color={c.text} />
                  <View style={s.grow}>
                    <Text style={s.sectionTitle}>Sparowany komputer</Text>
                    <Text style={s.meta}>{connected ? 'Połączono' : 'Rozłączono'}</Text>
                  </View>
                </View>
                <Text selectable style={s.address}>
                  {pairing.url}
                </Text>
                <Button
                  label={connected ? 'Rozłącz' : 'Połącz'}
                  secondary
                  disabled={connecting}
                  onPress={() => (connected ? client.disconnect() : void connect(pairing))}
                />
                <Button label="Zapomnij host" secondary onPress={() => void forget()} />
              </View>
            ) : (
              <View style={s.settingsGroup}>
                <Icon name="laptop-outline" size={30} color={c.text} />
                <Text style={s.sectionTitle}>Dodaj swój komputer</Text>
                <Text style={common.body}>
                  Zeskanuj jego kod QR. Na początek możesz połączyć jeden komputer.
                </Text>
              </View>
            )}
            <Button
              label="Sparuj komputer"
              icon="scan-outline"
              onPress={() => setConnectOpen(true)}
            />
            <View style={s.plainSection}>
              <Text style={s.sectionTitle}>Także na serwerze</Text>
              <Text style={common.body}>
                Host może działać na VPS-ie dostępnym w Twojej sieci VPN. Bezpośrednie łączenie
                przez SSH pojawi się w kolejnym etapie.
              </Text>
            </View>
          </>
        )}
        {tab === 'settings' && (
          <>
            <View style={s.intro}>
              <Text style={s.title}>Po Twojemu.</Text>
            </View>
            <View style={s.settingsGroup}>
              <Text style={s.sectionTitle}>Podgląd aplikacji</Text>
              <Text style={common.body}>Wypróbuj rozmowy i terminal na przykładowych danych.</Text>
              <Button
                label={mode === 'demo' ? 'Odtwórz sesje demo' : 'Włącz tryb demo'}
                secondary
                onPress={resetDemo}
              />
              {pairing && (
                <Button label="Wróć do swojego hosta" onPress={() => void connect(pairing)} />
              )}
            </View>
            <View style={s.plainSection}>
              <Text style={s.sectionTitle}>Twoje narzędzia i subskrypcje</Text>
              <Text style={common.body}>
                Uruchamiaj Claude Code lub Codex i loguj się na komputerze. Aplikacja nie wymaga
                kluczy API do modeli.
              </Text>
            </View>
            <View style={s.plainSection}>
              <Text style={s.sectionTitle}>Projekt open source</Text>
              <Text style={common.body}>Rozwijany otwarcie, na licencji MIT.</Text>
              <Button
                label="Kod na GitHubie"
                icon="logo-github"
                secondary
                onPress={() => void Linking.openURL('https://github.com/dkveil/pocket-sessions')}
              />
            </View>
            <Text style={s.footnote}>
              Wczesna wersja · 0.1{'\n'}Rozmowy są demonstracyjne. Prawdziwy terminal działa po
              połączeniu z komputerem.
            </Text>
          </>
        )}
      </ScrollView>
      {!!notice && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ukryj komunikat"
          onPress={() => setNotice('')}
          style={s.notice}
        >
          <Text style={s.noticeText}>{notice}</Text>
          <Icon name="close" size={18} />
        </Pressable>
      )}
      {tab === 'sessions' && (
        <View style={s.bottom}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Rozpocznij nową sesję"
            onPress={() => setCreateOpen(true)}
            style={({ pressed }) => [s.newSession, pressed && s.pressed]}
          >
            <Icon name="add" size={23} color={c.text} />
            <Text style={s.newSessionText}>Rozpocznij nową sesję</Text>
            <View style={s.newSessionArrow}>
              <Icon name="arrow-up" size={21} color={c.accentInk} />
            </View>
          </Pressable>
          <Text style={s.bottomHint}>
            {mode === 'demo'
              ? 'Podgląd aplikacji · bez połączenia z AI'
              : 'Sesje działają na Twoim komputerze'}
          </Text>
        </View>
      )}
      <Modal
        visible={menuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <View style={s.menuOverlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zamknij menu"
            onPress={() => setMenuOpen(false)}
            style={StyleSheet.absoluteFill}
          />
          <SafeAreaView style={s.menu}>
            <View style={s.menuHeader}>
              <Text style={s.headerTitle}>Twoja przestrzeń</Text>
              <IconButton
                name="close"
                label="Zamknij nawigację"
                onPress={() => setMenuOpen(false)}
              />
            </View>
            <ScrollView contentContainerStyle={s.menuContent}>
              {navigation.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="tab"
                  accessibilityLabel={item.label}
                  accessibilityState={{ selected: tab === item.id }}
                  onPress={() => {
                    setMenuOpen(false);
                    router.navigate(item.path);
                  }}
                  style={({ pressed }) => [
                    s.menuItem,
                    tab === item.id && s.menuSelected,
                    pressed && s.pressed,
                  ]}
                >
                  <Icon name={item.icon} size={21} color={c.text} />
                  <Text style={s.menuLabel}>{item.label}</Text>
                </Pressable>
              ))}
              {!!sessions.length && <Text style={s.menuSection}>Ostatnie sesje</Text>}
              {sessions.slice(0, 8).map((session) => (
                <Pressable
                  key={session.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Przejdź do sesji ${session.name}`}
                  onPress={() => {
                    setMenuOpen(false);
                    openSession(session.id);
                  }}
                  style={({ pressed }) => [s.menuItem, pressed && s.pressed]}
                >
                  <Text style={s.menuSession} numberOfLines={1}>
                    {session.name}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Połącz komputer z menu"
              onPress={() => {
                setMenuOpen(false);
                setConnectOpen(true);
              }}
              style={s.menuFooter}
            >
              <Icon name="laptop-outline" size={21} />
              <View style={s.grow}>
                <Text style={s.menuLabel}>Połącz komputer</Text>
                <Text style={s.meta}>{connectionLabel}</Text>
              </View>
              <Icon name="chevron-forward" size={16} />
            </Pressable>
          </SafeAreaView>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  header: {
    minHeight: 60,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: { flex: 1, color: c.text, fontSize: 19, fontWeight: '600', letterSpacing: -0.3 },
  content: { paddingHorizontal: 24, paddingBottom: 24, gap: 22 },
  intro: { paddingTop: 36, paddingBottom: 8, gap: 10 },
  title: { color: c.text, fontSize: 28, fontWeight: '600', letterSpacing: -0.8, lineHeight: 36 },
  subtitle: { color: c.muted, fontSize: 15, lineHeight: 23 },
  connection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  connectionTitle: { color: c.text, fontSize: 15, fontWeight: '500', marginBottom: 5 },
  grow: { flex: 1, minWidth: 0 },
  meta: { color: c.faint, fontSize: 12, lineHeight: 18 },
  reconnect: { gap: 12 },
  search: {
    backgroundColor: c.surface,
    borderRadius: 26,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: {
    color: c.text,
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    minHeight: 48,
    paddingVertical: 10,
  },
  filters: { flexDirection: 'row', gap: 6, marginTop: -8 },
  filter: {
    minHeight: 44,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
  },
  activeFilter: { backgroundColor: c.surface },
  filterText: { color: c.muted, fontSize: 13, fontWeight: '500' },
  activeFilterText: { color: c.text },
  sessionList: { marginHorizontal: -8, marginTop: -12 },
  sessionRow: {
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 8,
    paddingVertical: 19,
    borderRadius: 14,
  },
  sessionIcon: { paddingTop: 2 },
  sessionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sessionTitle: { color: c.text, fontSize: 16, fontWeight: '500', lineHeight: 23, flexShrink: 1 },
  sessionPreview: { color: c.muted, fontSize: 14, lineHeight: 21, marginTop: 4, marginBottom: 5 },
  attentionDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.orange },
  empty: { alignItems: 'center', gap: 14, paddingVertical: 35, paddingHorizontal: 20 },
  center: { textAlign: 'center' },
  sectionTitle: { color: c.text, fontSize: 17, fontWeight: '500', lineHeight: 25 },
  settingsGroup: { backgroundColor: c.surface, borderRadius: 22, padding: 20, gap: 16 },
  plainSection: { gap: 12, paddingVertical: 12 },
  address: { color: c.muted, fontSize: 13, lineHeight: 20, fontFamily: mono },
  footnote: { color: c.faint, fontSize: 13, lineHeight: 21 },
  notice: {
    marginHorizontal: 20,
    marginBottom: 12,
    padding: 16,
    borderRadius: 18,
    backgroundColor: c.elevated,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  noticeText: { flex: 1, color: c.text, fontSize: 14, lineHeight: 21 },
  bottom: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 12 },
  newSession: {
    backgroundColor: c.surface,
    borderRadius: 32,
    minHeight: 62,
    paddingLeft: 18,
    paddingRight: 12,
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
  },
  newSessionText: { flex: 1, color: c.muted, fontSize: 16 },
  newSessionArrow: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomHint: { color: c.faint, fontSize: 11, textAlign: 'center' },
  pressed: { backgroundColor: c.elevated },
  menuOverlay: { flex: 1, backgroundColor: '#00000099' },
  menu: {
    width: '86%',
    maxWidth: 340,
    height: '100%',
    backgroundColor: c.surface,
    borderTopRightRadius: 24,
    borderBottomRightRadius: 24,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 24,
    paddingRight: 12,
    minHeight: 70,
  },
  menuContent: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 24, gap: 4 },
  menuItem: {
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 50,
    borderRadius: 16,
  },
  menuSelected: { backgroundColor: c.elevated },
  menuLabel: { color: c.text, fontSize: 16, lineHeight: 23 },
  menuSession: { color: c.text, fontSize: 15, lineHeight: 22 },
  menuSection: {
    color: c.faint,
    fontSize: 13,
    paddingHorizontal: 16,
    marginTop: 30,
    marginBottom: 10,
  },
  menuFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 20,
    paddingVertical: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
});
