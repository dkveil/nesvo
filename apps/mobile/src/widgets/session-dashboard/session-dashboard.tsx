import React, { useRef, useState } from 'react';

import {
  Keyboard,
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

import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { groupDescendants, groupPath } from '@entities/group';
import { SessionStatusBadge, statusNeedsAttention } from '@entities/session';
import { useWorkspace } from '@entities/workspace';

import { NesvoLogo } from '@shared/brand';
import { colors as c, mono } from '@shared/theme';
import { Button, common, Icon, IconButton } from '@shared/ui';

import { SessionLaunchpad } from './session-launchpad';

const navigation = [
  { id: 'sessions', icon: 'terminal-outline', label: 'Sesje' },
  { id: 'hosts', icon: 'desktop-outline', label: 'Komputery' },
  { id: 'settings', icon: 'settings-outline', label: 'Ustawienia' },
] as const;
export type DashboardTab = (typeof navigation)[number]['id'];

export function DashboardScreen({ tab, active = false }: { tab: DashboardTab; active?: boolean }) {
  const insets = useSafeAreaInsets();
  const {
    client,
    mode,
    sessions,
    connected,
    connecting,
    pairing,
    setConnectOpen,
    setCreateOpen,
    createOpen,
    connectOpen,
    setSessionName,
    hostCapabilities,
    query,
    setQuery,
    filter,
    setFilter,
    notice,
    setNotice,
    connect,
    forget,
    resetDemo,
    groups,
    selectedGroup,
    setSessionGroup,
    setCreateError,
    openSession,
    navigateTo,
  } = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoVisible, setLogoVisible] = useState(true);
  const visibility = useRef({ visible: true, top: 0, height: 0, logoTop: 0, logoBottom: 0 });
  function updateLogoVisibility() {
    const area = visibility.current;
    const next =
      !area.height || (area.logoBottom > area.top && area.logoTop < area.top + area.height);
    if (next !== area.visible) {
      area.visible = next;
      setLogoVisible(next);
    }
  }
  function openCreate(name: string) {
    Keyboard.dismiss();
    setCreateError('');
    setSessionName(name);
    setSessionGroup(selectedGroup === 'all' ? null : selectedGroup);
    setCreateOpen(true);
  }
  function newSession() {
    openCreate('');
  }
  const groupIds =
    selectedGroup && selectedGroup !== 'all' ? groupDescendants(groups, selectedGroup) : null;
  const showStartMenu = tab === 'sessions' && (mode === 'demo' || sessions.length === 0);
  const connectionLabel =
    mode === 'demo'
      ? 'Tryb demo'
      : connected
        ? 'Połączono'
        : connecting
          ? 'Łączenie…'
          : 'Rozłączono';
  const visible = sessions.filter(
    session =>
      (selectedGroup === 'all' ||
        (selectedGroup === null
          ? !session.groupId
          : !!session.groupId && groupIds?.has(session.groupId))) &&
      (filter === 'all' || statusNeedsAttention(session.status)) &&
      `${session.name} ${session.project} ${session.agent}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const sections = [...new Set(visible.map(session => session.groupId ?? null))].map(id => ({
    id,
    name: groupPath(groups, id),
    sessions: visible.filter(session => (session.groupId ?? null) === id),
  }));
  const attentionCount = sessions.filter(session => statusNeedsAttention(session.status)).length;

  return (
    <KeyboardAvoidingView
      style={s.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <View style={s.header}>
        <IconButton name="menu-outline" label="Otwórz menu" onPress={() => setMenuOpen(true)} />
        <View style={s.headerTitle}>
          <NesvoLogo width={118} />
          <Text style={s.headerRoute} numberOfLines={1}>
            / {navigation.find(item => item.id === tab)?.label.toLocaleLowerCase()}
          </Text>
        </View>
        <IconButton name="add" label="Nowa sesja" onPress={newSession} />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={s.content}
        scrollEventThrottle={100}
        onLayout={event => {
          visibility.current.height = event.nativeEvent.layout.height;
          updateLogoVisibility();
        }}
        onScroll={event => {
          visibility.current.top = event.nativeEvent.contentOffset.y;
          updateLogoVisibility();
        }}
      >
        {tab === 'sessions' && (
          <>
            <View style={s.workspaceBar}>
              <Text style={s.workspaceLabel}>workspace</Text>
              <Text style={s.workspaceCount}>
                {sessions.length.toString().padStart(2, '0')} sesji
                {attentionCount ? ` · ${attentionCount} wymagają uwagi` : ''}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                mode === 'demo' ? 'Połącz swój komputer' : 'Zarządzaj połączeniem'
              }
              onPress={() => (mode === 'demo' ? setConnectOpen(true) : navigateTo('hosts'))}
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
            {!!showStartMenu && (
              <View
                style={s.startMenu}
                onLayout={event => {
                  const delta = event.nativeEvent.layout.y - visibility.current.logoTop;
                  visibility.current.logoTop += delta;
                  visibility.current.logoBottom += delta;
                  updateLogoVisibility();
                }}
              >
                <SessionLaunchpad
                  active={!!active && !!logoVisible && !menuOpen && !createOpen && !connectOpen}
                  demo={mode === 'demo'}
                  workspace={hostCapabilities?.workspace}
                  onCreate={openCreate}
                  onLogoLayout={bottom => {
                    visibility.current.logoBottom = visibility.current.logoTop + bottom;
                    updateLogoVisibility();
                  }}
                />
                {mode === 'demo' && !!pairing && (
                  <Button
                    label="Wróć do swojego komputera"
                    secondary
                    onPress={() => void connect(pairing)}
                  />
                )}
              </View>
            )}
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
                selectionColor={c.accent}
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
              {(['all', 'attention'] as const).map(value => (
                <Pressable
                  key={value}
                  accessibilityRole="tab"
                  aria-selected={filter === value}
                  accessibilityState={{ selected: filter === value }}
                  onPress={() => setFilter(value)}
                  style={[s.filter, filter === value && s.activeFilter]}
                >
                  <Text style={[s.filterText, filter === value && s.activeFilterText]}>
                    {value === 'all' ? 'Wszystkie' : 'Wymagają uwagi'}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Zarządzaj grupami"
                onPress={() => navigateTo('groups')}
                style={s.groupFilter}
              >
                <Icon
                  name="folder-outline"
                  size={18}
                  color={selectedGroup === 'all' ? c.muted : c.accent}
                />
              </Pressable>
            </View>
            <View style={s.sessionList}>
              {sections.map(section => (
                <View key={section.id ?? 'ungrouped'} style={s.sessionSection}>
                  <View style={s.sectionHeading}>
                    <Icon name={section.id ? 'folder-open-outline' : 'albums-outline'} size={14} />
                    <Text style={s.sectionPath} numberOfLines={1}>
                      {section.name}
                    </Text>
                    <Text style={s.sectionCount}>
                      {section.sessions.length.toString().padStart(2, '0')}
                    </Text>
                  </View>
                  {section.sessions.map(session => (
                    <Pressable
                      key={session.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Otwórz sesję ${session.name}`}
                      onPress={() => openSession(session.id)}
                      style={({ pressed }) => [s.sessionRow, pressed && s.pressed]}
                    >
                      <View style={s.grow}>
                        <View style={s.sessionTitleRow}>
                          <Text style={s.sessionTitle} numberOfLines={1}>
                            {session.name}
                          </Text>
                          <SessionStatusBadge
                            status={session.status}
                            source={session.statusSource}
                            demo={!session.live}
                          />
                        </View>
                        <View style={s.sessionMeta}>
                          <Text style={s.sessionAgent}>{session.agent}</Text>
                          <Text style={s.sessionCwd} numberOfLines={1} ellipsizeMode="middle">
                            {session.cwd}
                          </Text>
                          {!session.live && <Text style={s.demoTag}>demo</Text>}
                        </View>
                      </View>
                    </Pressable>
                  ))}
                </View>
              ))}
              {!visible.length && (
                <View style={s.empty}>
                  <Icon name="terminal-outline" size={28} />
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
              <Text style={s.title}>Hosty</Text>
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
              <Text style={s.title}>Konfiguracja</Text>
            </View>
            <View style={s.settingsGroup}>
              <Text style={s.sectionTitle}>Podgląd aplikacji</Text>
              <Text style={common.body}>Wypróbuj rozmowy i terminal na przykładowych danych.</Text>
              <Button
                label={mode === 'demo' ? 'Odtwórz sesje demo' : 'Włącz tryb demo'}
                secondary
                onPress={resetDemo}
              />
              {!!pairing && (
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
              <Text style={common.body}>nesvo · rozwijane otwarcie, na licencji MIT.</Text>
              <Button
                label="Kod na GitHubie"
                icon="logo-github"
                secondary
                onPress={() => void Linking.openURL('https://github.com/dkveil/nesvo')}
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
      {tab === 'sessions' && !showStartMenu && (
        <View style={s.bottom}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Rozpocznij nową sesję"
            onPress={newSession}
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
              <View style={s.headerTitle}>
                <NesvoLogo width={118} />
              </View>
              <IconButton
                name="close"
                label="Zamknij nawigację"
                onPress={() => setMenuOpen(false)}
              />
            </View>
            <ScrollView contentContainerStyle={s.menuContent}>
              {navigation.map(item => (
                <Pressable
                  key={item.id}
                  accessibilityRole="tab"
                  accessibilityLabel={item.label}
                  accessibilityState={{ selected: tab === item.id }}
                  onPress={() => {
                    setMenuOpen(false);
                    navigateTo(item.id);
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
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Grupy i podgrupy"
                onPress={() => {
                  setMenuOpen(false);
                  navigateTo('groups');
                }}
                style={s.menuItem}
              >
                <Icon name="folder-outline" color={c.text} size={21} />
                <Text style={s.menuLabel}>Grupy i podgrupy</Text>
              </Pressable>
              {!!sessions.length && <Text style={s.menuSection}>Ostatnie sesje</Text>}
              {sessions.slice(0, 8).map(session => (
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
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  header: {
    minHeight: 54,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  headerTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  headerRoute: { color: c.faint, fontFamily: mono, fontSize: 11, flexShrink: 1 },
  content: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 20, gap: 10 },
  workspaceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 22,
    gap: 8,
  },
  workspaceLabel: { fontFamily: mono, color: c.muted, fontSize: 12 },
  workspaceCount: { fontFamily: mono, color: c.faint, fontSize: 10 },
  intro: { paddingTop: 12, paddingBottom: 8, gap: 8 },
  title: {
    color: c.text,
    fontFamily: mono,
    fontSize: 23,
    fontWeight: '600',
    letterSpacing: -0.6,
    lineHeight: 30,
  },
  subtitle: { color: c.muted, fontSize: 14, lineHeight: 21 },
  connection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 54,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  connectionTitle: {
    color: c.text,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  grow: { flex: 1, minWidth: 0 },
  meta: { color: c.faint, fontSize: 11, lineHeight: 16 },
  reconnect: { gap: 12, paddingVertical: 8 },
  startMenu: { gap: 10 },
  search: {
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: {
    color: c.text,
    fontFamily: mono,
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    minHeight: 44,
    paddingVertical: 10,
  },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  groupFilter: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    width: 44,
    marginLeft: 'auto',
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
  },
  filter: {
    minHeight: 44,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeFilter: { borderBottomColor: c.accent },
  filterText: { color: c.muted, fontFamily: mono, fontSize: 11, fontWeight: '500' },
  activeFilterText: { color: c.accent },
  sessionList: { gap: 12, paddingTop: 2 },
  sessionSection: { borderWidth: 1, borderColor: c.border, borderRadius: 6, overflow: 'hidden' },
  sectionHeading: {
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
    minHeight: 32,
    paddingHorizontal: 10,
    backgroundColor: c.surface,
  },
  sectionPath: { flex: 1, fontFamily: mono, color: c.muted, fontSize: 11 },
  sectionCount: { fontFamily: mono, color: c.faint, fontSize: 10 },
  sessionRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 13,
    minHeight: 76,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
  sessionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sessionTitle: {
    color: c.text,
    fontFamily: mono,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 21,
    flex: 1,
  },
  sessionMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  sessionAgent: { color: c.accent, fontFamily: mono, fontSize: 10 },
  sessionCwd: { flex: 1, minWidth: 0, color: c.faint, fontFamily: mono, fontSize: 10 },
  demoTag: { color: c.faint, fontFamily: mono, fontSize: 9 },
  empty: { alignItems: 'center', gap: 14, paddingVertical: 30, paddingHorizontal: 16 },
  center: { textAlign: 'center' },
  sectionTitle: {
    color: c.text,
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 23,
  },
  settingsGroup: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    padding: 16,
    gap: 14,
  },
  plainSection: { gap: 10, paddingVertical: 12 },
  address: { color: c.muted, fontSize: 12, lineHeight: 20, fontFamily: mono },
  footnote: { color: c.faint, fontSize: 12, lineHeight: 19 },
  notice: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  noticeText: { flex: 1, color: c.text, fontSize: 13, lineHeight: 20 },
  bottom: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  newSession: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 6,
    minHeight: 48,
    paddingHorizontal: 12,
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
  },
  newSessionText: { flex: 1, color: c.accent, fontFamily: mono, fontSize: 13 },
  newSessionArrow: {
    width: 28,
    height: 28,
    borderRadius: 4,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomHint: { color: c.faint, fontFamily: mono, fontSize: 10, textAlign: 'center' },
  pressed: { backgroundColor: c.elevated },
  menuOverlay: { flex: 1, backgroundColor: '#00000099' },
  menu: {
    width: '86%',
    maxWidth: 340,
    height: '100%',
    backgroundColor: c.surface,
    borderRightWidth: 1,
    borderRightColor: c.border,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 18,
    paddingRight: 8,
    minHeight: 58,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  menuContent: { paddingHorizontal: 10, paddingTop: 12, paddingBottom: 24, gap: 4 },
  menuItem: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 46,
    borderRadius: 4,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  menuSelected: { backgroundColor: c.elevated, borderLeftColor: c.accent },
  menuLabel: { color: c.text, fontFamily: mono, fontSize: 13, lineHeight: 21 },
  menuSession: { color: c.text, fontFamily: mono, fontSize: 12, lineHeight: 20 },
  menuSection: {
    color: c.faint,
    fontFamily: mono,
    fontSize: 11,
    paddingHorizontal: 14,
    marginTop: 20,
    marginBottom: 6,
  },
  menuFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    paddingVertical: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
  },
});
