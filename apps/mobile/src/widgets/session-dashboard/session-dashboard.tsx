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

import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { NotificationSettings } from '@features/notifications';

import { groupDescendants, groupPath } from '@entities/group';
import { useInbox } from '@entities/inbox';
import {
  sessionAgentColor,
  sessionLastKnownLabel,
  SessionStatusBadge,
  SessionStatusDot,
  statusNeedsAttention,
} from '@entities/session';
import { useWorkspace } from '@entities/workspace';

import { NesvoLogo, useMotionPreference } from '@shared/brand';
import { colors as c, mono } from '@shared/theme';
import { Button, common, FreshnessBadge, Icon, IconButton } from '@shared/ui';

import { DashboardNavigation, type DashboardTab } from './dashboard-navigation';
import { SessionLaunchpad } from './session-launchpad';

export type { DashboardTab } from './dashboard-navigation';

function limitWindowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function DashboardScreen({ tab, active = false }: { tab: DashboardTab; active?: boolean }) {
  const insets = useSafeAreaInsets();
  const motionAllowed = useMotionPreference();
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
  const inbox = useInbox();
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
  const showStartMenu = tab === 'sessions' && sessions.length === 0;
  const connectionLabel =
    mode === 'demo'
      ? 'Demo mode'
      : connected
        ? 'Connected'
        : connecting
          ? 'Connecting…'
          : 'Disconnected';
  const visible = sessions.filter(
    session =>
      (selectedGroup === 'all' ||
        (selectedGroup === null
          ? !session.groupId
          : !!session.groupId && groupIds?.has(session.groupId))) &&
      (filter === 'all' || statusNeedsAttention(session.status, session.currentAttention)) &&
      `${session.name} ${session.project} ${session.agent}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const sections = [...new Set(visible.map(session => session.groupId ?? null))].map(id => ({
    id,
    name: groupPath(groups, id),
    sessions: visible.filter(session => (session.groupId ?? null) === id),
  }));
  const attentionCount = sessions.filter(session =>
    statusNeedsAttention(session.status, session.currentAttention),
  ).length;
  const providerLimits = hostCapabilities?.providerLimits ?? [];
  const jobsSupported = mode === 'live' && hostCapabilities?.jobPages === true;

  return (
    <KeyboardAvoidingView
      style={s.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <View style={s.header}>
        <IconButton name="menu-outline" label="Open menu" onPress={() => setMenuOpen(true)} />
        <View style={s.headerTitle}>
          <NesvoLogo width={96} />
        </View>
        {inbox.supported ? (
          <IconButton
            name="file-tray-outline"
            label={`Inbox, ${inbox.total} to review`}
            badge={inbox.total}
            onPress={() => navigateTo('inbox')}
          />
        ) : null}
        <IconButton
          name="add"
          label={tab === 'hosts' ? 'Add a computer' : 'New session'}
          onPress={tab === 'hosts' ? () => setConnectOpen(true) : newSession}
        />
      </View>
      <ScrollView
        keyboardDismissMode="on-drag"
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
            <View style={s.homeIntro}>
              <Text style={s.homeTitle}>Your workspace</Text>
              <Text style={s.homeSummary}>
                {sessions.length} {sessions.length === 1 ? 'session' : 'sessions'}
                {attentionCount ? ` · ${attentionCount} need you` : ''}
              </Text>
            </View>
            <Text style={s.eyebrow}>COMPUTER</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={mode === 'demo' ? 'Connect your computer' : 'Manage connection'}
              onPress={() => (mode === 'demo' ? setConnectOpen(true) : navigateTo('hosts'))}
              style={({ pressed }) => [s.connection, pressed && s.pressed]}
            >
              <View style={s.hostIcon}>
                <Icon
                  name={mode === 'demo' ? 'link-outline' : 'desktop-outline'}
                  size={20}
                  color={c.text}
                />
              </View>
              <View style={s.grow}>
                <Text style={s.connectionTitle}>
                  {mode === 'demo'
                    ? 'Your computer'
                    : pairing
                      ? new URL(pairing.url).hostname
                      : 'Connect a computer'}
                </Text>
                <View style={s.connectionState}>
                  <View
                    style={[
                      s.connectionDot,
                      {
                        backgroundColor: connected
                          ? c.success
                          : mode === 'demo'
                            ? c.faint
                            : c.warning,
                      },
                    ]}
                  />
                  <Text style={s.meta}>
                    {mode === 'demo'
                      ? 'Demo mode · the sessions below are samples'
                      : connectionLabel}
                  </Text>
                </View>
              </View>
              <Icon name="chevron-forward" size={18} color={c.faint} />
            </Pressable>
            {mode === 'live' && connected && providerLimits.length > 0 ? (
              <View style={s.providerSection}>
                <Text style={s.eyebrow}>PROVIDER LIMITS</Text>
                {providerLimits.map(provider => (
                  <View key={provider.id} style={s.providerRow}>
                    <Text style={s.providerName}>
                      {provider.id === 'claude'
                        ? 'Claude'
                        : provider.id === 'gemini'
                          ? 'Gemini'
                          : 'Codex'}
                    </Text>
                    {provider.status === 'ready' ? (
                      <View style={s.providerWindows}>
                        {[...provider.windows]
                          .sort((a, b) => a.durationMins - b.durationMins)
                          .map(window => (
                            <View key={window.durationMins} style={s.providerWindow}>
                              <Text style={s.providerWindowText}>
                                {limitWindowLabel(window.durationMins)} {window.usedPercent}%
                              </Text>
                              <View style={s.providerTrack}>
                                <View
                                  style={[
                                    s.providerFill,
                                    {
                                      width: `${window.usedPercent}%`,
                                      backgroundColor:
                                        window.usedPercent >= 90 ? c.warning : c.accent,
                                    },
                                  ]}
                                />
                              </View>
                            </View>
                          ))}
                      </View>
                    ) : (
                      <Text style={s.providerHint}>
                        {provider.status === 'checking'
                          ? 'Reading…'
                          : provider.id === 'claude'
                            ? 'Check in Claude: /usage'
                            : provider.id === 'gemini'
                              ? 'Check in Gemini: /stats model'
                              : 'Limit unavailable in Codex'}
                      </Text>
                    )}
                  </View>
                ))}
                {providerLimits.some(provider => provider.status === 'ready') ? (
                  <Text style={s.providerCaption}>Limit used</Text>
                ) : null}
              </View>
            ) : null}
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
                    label="Back to your computer"
                    secondary
                    onPress={() => void connect(pairing)}
                  />
                )}
              </View>
            )}
            {mode === 'live' && !connected && (
              <View style={s.reconnect}>
                <Text style={common.body}>Sessions wait on the computer while the host runs.</Text>
                <Button
                  label={pairing ? 'Reconnect' : 'Pair a computer'}
                  disabled={connecting}
                  onPress={() => (pairing ? void connect(pairing) : setConnectOpen(true))}
                />
              </View>
            )}
            <View style={s.sessionListHeading}>
              <Text style={s.eyebrow}>SESSIONS</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Manage groups"
                onPress={() => navigateTo('groups')}
                style={s.groupsLink}
              >
                <Text style={s.groupsLinkText}>Groups</Text>
                <Icon name="chevron-forward" size={14} color={c.muted} />
              </Pressable>
            </View>
            {(sessions.length >= 5 || !!query) && (
              <View style={s.search}>
                <Icon name="search-outline" size={18} />
                <TextInput
                  accessibilityLabel="Search sessions"
                  value={query}
                  onChangeText={setQuery}
                  placeholder="Search sessions"
                  placeholderTextColor={c.faint}
                  selectionColor={c.accent}
                  style={s.searchInput}
                />
                {!!query && (
                  <IconButton name="close" label="Clear search" onPress={() => setQuery('')} />
                )}
              </View>
            )}
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
                    {value === 'all' ? 'All' : 'Need you'}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={s.sessionList}>
              {sections.map(section => (
                <View key={section.id ?? 'ungrouped'} style={s.sessionSection}>
                  <View style={s.sectionHeading}>
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
                      accessibilityLabel={`Open session ${session.name}`}
                      onPress={() => openSession(session.id)}
                      style={({ pressed }) => [s.sessionRow, pressed && s.pressed]}
                    >
                      <View style={s.statusSlot}>
                        <SessionStatusDot
                          status={session.status}
                          source={session.statusSource}
                          active={
                            !!active && !!session.live && !menuOpen && !createOpen && !connectOpen
                          }
                        />
                      </View>
                      <View style={s.grow}>
                        <View style={s.sessionTitleRow}>
                          <Text style={s.sessionTitle} numberOfLines={1}>
                            {session.name}
                          </Text>
                          <SessionStatusBadge
                            variant="plain"
                            readiness={session.readiness}
                            hibernated={session.hibernated}
                            currentAttention={session.currentAttention}
                            status={session.status}
                            source={session.statusSource}
                            demo={!session.live}
                          />
                        </View>
                        <View style={s.sessionMeta}>
                          <Text
                            style={[s.sessionAgent, { color: sessionAgentColor(session.agent) }]}
                          >
                            {session.agent}
                          </Text>
                          <Text style={s.sessionCwd} numberOfLines={1} ellipsizeMode="middle">
                            {session.cwd}
                          </Text>
                        </View>
                        {session.statusFreshness ? (
                          <View style={s.sessionFreshness}>
                            <FreshnessBadge
                              receivedAt={session.statusFreshness.observedAt}
                              connected={session.statusFreshness.stale ? false : connected}
                            />
                            {session.statusFreshness.lastKnown ? (
                              <Text style={s.sessionLastKnown}>
                                {sessionLastKnownLabel(session.statusFreshness)}
                              </Text>
                            ) : null}
                          </View>
                        ) : null}
                      </View>
                    </Pressable>
                  ))}
                </View>
              ))}
              {!visible.length && (
                <View style={s.empty}>
                  <Icon name="terminal-outline" size={28} />
                  <Text style={s.sectionTitle}>
                    {sessions.length ? 'No matching sessions' : 'Room for your first session'}
                  </Text>
                  <Text style={[common.body, s.center]}>
                    {sessions.length
                      ? 'Change the filter or search text.'
                      : 'Open a new session to start working on your computer.'}
                  </Text>
                </View>
              )}
            </View>
          </>
        )}
        {tab === 'hosts' && (
          <>
            <View style={s.intro}>
              <Text style={s.title}>Computers</Text>
            </View>
            <Text style={s.eyebrow}>CONNECTIONS</Text>
            {pairing ? (
              <View style={s.hostCard}>
                <View style={s.hostCardHeader}>
                  <View style={s.hostIcon}>
                    <Icon name="desktop-outline" size={22} color={c.text} />
                  </View>
                  <View style={s.grow}>
                    <Text style={s.sectionTitle}>{new URL(pairing.url).hostname}</Text>
                    <View style={s.connectionState}>
                      <View
                        style={[
                          s.connectionDot,
                          { backgroundColor: connected ? c.success : c.warning },
                        ]}
                      />
                      <Text style={s.meta}>{connectionLabel}</Text>
                    </View>
                  </View>
                </View>
                <Text selectable style={s.address}>
                  {pairing.url}
                </Text>
                <View style={s.hostActions}>
                  <Button
                    label={connected ? 'Disconnect' : 'Connect'}
                    secondary
                    disabled={connecting}
                    onPress={() => (connected ? client.disconnect() : void connect(pairing))}
                  />
                  <Button label="Forget" secondary onPress={() => void forget()} />
                </View>
              </View>
            ) : (
              <View style={s.hostCard}>
                <View style={s.hostCardHeader}>
                  <View style={s.hostIcon}>
                    <Icon name="desktop-outline" size={22} color={c.text} />
                  </View>
                  <View style={s.grow}>
                    <Text style={s.sectionTitle}>No connected computer</Text>
                    <Text style={s.meta}>Pair a nesvo host with a QR code.</Text>
                  </View>
                </View>
              </View>
            )}
            <Text style={s.eyebrow}>QUICK ACTIONS</Text>
            <Button
              label="Pair a computer"
              icon="scan-outline"
              onPress={() => setConnectOpen(true)}
            />
          </>
        )}
        {tab === 'settings' && (
          <>
            <View style={s.intro}>
              <Text style={s.title}>Settings</Text>
            </View>
            <View style={s.settingsGroup}>
              <NotificationSettings />
            </View>
            <View style={s.settingsGroup}>
              <Text style={s.sectionTitle}>App preview</Text>
              <Text style={common.body}>Try sessions and the terminal with sample data.</Text>
              <Button
                label={mode === 'demo' ? 'Restore demo sessions' : 'Turn on demo mode'}
                secondary
                onPress={resetDemo}
              />
              {!!pairing && (
                <Button label="Back to your host" onPress={() => void connect(pairing)} />
              )}
            </View>
            <View style={s.plainSection}>
              <Text style={s.sectionTitle}>Your tools and subscriptions</Text>
              <Text style={common.body}>
                Run Claude Code or Codex and sign in on your computer. The app needs no model API
                keys.
              </Text>
            </View>
            <View style={s.plainSection}>
              <Text style={s.sectionTitle}>Open source project</Text>
              <Text style={common.body}>nesvo · developed in the open under the MIT license.</Text>
              <Button
                label="Code on GitHub"
                icon="logo-github"
                secondary
                onPress={() => void Linking.openURL('https://github.com/dkveil/nesvo')}
              />
            </View>
            <Text style={s.footnote}>
              Early version · 0.1{'\n'}The real terminal works after connecting a computer.
            </Text>
          </>
        )}
      </ScrollView>
      {!!notice && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss message"
          onPress={() => setNotice('')}
          style={s.notice}
        >
          <Text style={s.noticeText}>{notice}</Text>
          <Icon name="close" size={18} />
        </Pressable>
      )}
      <DashboardNavigation selected={tab} onSelect={navigateTo} />
      <Modal
        visible={menuOpen}
        transparent
        animationType={motionAllowed ? 'fade' : 'none'}
        onRequestClose={() => setMenuOpen(false)}
      >
        <SafeAreaProvider>
          <SafeAreaView style={s.menuOverlay} edges={['top', 'bottom', 'left', 'right']}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close menu"
              onPress={() => setMenuOpen(false)}
              style={StyleSheet.absoluteFill}
            />
            <View style={s.menu} testID="session-switcher">
              <View style={s.menuHeader}>
                <View style={s.headerTitle}>
                  <NesvoLogo width={118} />
                </View>
                <IconButton
                  name="close"
                  label="Close navigation"
                  onPress={() => setMenuOpen(false)}
                />
              </View>
              <ScrollView style={s.menuScroll} contentContainerStyle={s.menuContent}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Groups and subgroups"
                  onPress={() => {
                    setMenuOpen(false);
                    navigateTo('groups');
                  }}
                  style={s.menuItem}
                >
                  <Icon name="folder-outline" color={c.text} size={21} />
                  <Text style={s.menuLabel}>Groups and subgroups</Text>
                </Pressable>
                {inbox.supported ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Inbox"
                    onPress={() => {
                      setMenuOpen(false);
                      navigateTo('inbox');
                    }}
                    style={({ pressed }) => [s.menuItem, pressed && s.pressed]}
                  >
                    <Icon name="file-tray-outline" color={c.text} size={21} />
                    <Text style={s.menuLabel}>Inbox</Text>
                  </Pressable>
                ) : null}
                {inbox.decisionsSupported ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Decisions"
                    onPress={() => {
                      setMenuOpen(false);
                      navigateTo('decisions');
                    }}
                    style={({ pressed }) => [s.menuItem, pressed && s.pressed]}
                  >
                    <Icon name="help-circle-outline" color={c.text} size={21} />
                    <Text style={s.menuLabel}>Decisions</Text>
                  </Pressable>
                ) : null}
                {jobsSupported ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Jobs"
                    onPress={() => {
                      setMenuOpen(false);
                      navigateTo('jobs');
                    }}
                    style={({ pressed }) => [s.menuItem, pressed && s.pressed]}
                  >
                    <Icon name="calendar-outline" color={c.text} size={21} />
                    <Text style={s.menuLabel}>Jobs</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Settings"
                  onPress={() => {
                    setMenuOpen(false);
                    navigateTo('settings');
                  }}
                  style={({ pressed }) => [s.menuItem, pressed && s.pressed]}
                >
                  <Icon name="settings-outline" color={c.text} size={21} />
                  <Text style={s.menuLabel}>Settings</Text>
                </Pressable>
                {!!sessions.length && <Text style={s.menuSection}>Recent sessions</Text>}
                {sessions.slice(0, 8).map(session => (
                  <Pressable
                    key={session.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Go to session ${session.name}`}
                    onPress={() => {
                      setMenuOpen(false);
                      openSession(session.id);
                    }}
                    style={({ pressed }) => [s.menuSessionRow, pressed && s.pressed]}
                  >
                    <View style={s.statusSlot}>
                      <SessionStatusDot
                        status={session.status}
                        source={session.statusSource}
                        active={!!menuOpen && !!session.live && !createOpen && !connectOpen}
                      />
                    </View>
                    <View style={s.grow}>
                      <View style={s.sessionTitleRow}>
                        <Text style={s.menuSession} numberOfLines={1}>
                          {session.name}
                        </Text>
                        <SessionStatusBadge
                          variant="plain"
                          readiness={session.readiness}
                          hibernated={session.hibernated}
                          currentAttention={session.currentAttention}
                          status={session.status}
                          source={session.statusSource}
                          demo={!session.live}
                        />
                      </View>
                      <View style={s.menuSessionMeta}>
                        <Text style={[s.sessionAgent, { color: sessionAgentColor(session.agent) }]}>
                          {session.agent}
                        </Text>
                        <Text style={s.menuSessionGroup} numberOfLines={1}>
                          {groupPath(groups, session.groupId)}
                        </Text>
                      </View>
                      <Text style={s.menuSessionCwd} numberOfLines={1} ellipsizeMode="middle">
                        {session.cwd}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Connect a computer from the menu"
                onPress={() => {
                  setMenuOpen(false);
                  setConnectOpen(true);
                }}
                style={s.menuFooter}
              >
                <Icon name="laptop-outline" size={21} />
                <View style={s.grow}>
                  <Text style={s.menuLabel}>Connect a computer</Text>
                  <Text style={s.meta}>{connectionLabel}</Text>
                </View>
                <Icon name="chevron-forward" size={16} />
              </Pressable>
            </View>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: c.background },
  header: {
    minHeight: 66,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' },
  content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28, gap: 10 },
  homeIntro: { gap: 2, marginBottom: 8 },
  homeTitle: {
    color: c.text,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: -0.7,
    lineHeight: 36,
  },
  homeSummary: { color: c.muted, fontSize: 13, lineHeight: 20 },
  intro: { paddingTop: 12, paddingBottom: 8, gap: 8 },
  eyebrow: { color: c.muted, fontSize: 12, fontWeight: '600', letterSpacing: 1.2, marginTop: 10 },
  hostCard: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 10,
    padding: 14,
    gap: 12,
  },
  hostCardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hostActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hostIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.elevated,
    borderRadius: 11,
  },
  connectionState: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  connectionDot: { width: 7, height: 7, borderRadius: 4 },
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
    gap: 12,
    minHeight: 78,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
  },
  connectionTitle: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 3,
  },
  grow: { flex: 1, minWidth: 0 },
  meta: { color: c.muted, fontSize: 13, lineHeight: 18 },
  providerSection: { gap: 2, paddingVertical: 2 },
  providerRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  providerName: { width: 62, color: c.text, fontSize: 13, fontWeight: '600' },
  providerWindows: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  providerWindow: { flex: 1, minWidth: 0, gap: 3 },
  providerWindowText: { color: c.muted, fontSize: 11 },
  providerTrack: { height: 3, backgroundColor: c.elevated, borderRadius: 2, overflow: 'hidden' },
  providerFill: { height: 3, borderRadius: 2 },
  providerHint: { flex: 1, color: c.muted, fontSize: 11 },
  providerCaption: { color: c.faint, fontSize: 10, marginTop: 4 },
  reconnect: { gap: 12, paddingVertical: 8 },
  startMenu: { gap: 10 },
  search: {
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 13,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  searchInput: {
    color: c.text,
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    minHeight: 44,
    paddingVertical: 10,
  },
  sessionListHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  groupsLink: { flexDirection: 'row', alignItems: 'center', minHeight: 36, gap: 2 },
  groupsLinkText: { color: c.muted, fontSize: 12, fontWeight: '500' },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  filter: {
    minHeight: 44,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeFilter: { borderBottomColor: c.accent },
  filterText: { color: c.muted, fontSize: 12, fontWeight: '600' },
  activeFilterText: { color: c.accent },
  sessionList: { gap: 20, paddingTop: 6 },
  sessionSection: { gap: 4 },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 32,
    paddingHorizontal: 2,
  },
  sectionPath: { flex: 1, color: c.muted, fontSize: 12, fontWeight: '600' },
  sectionCount: { color: c.faint, fontSize: 11 },
  sessionRow: {
    flexDirection: 'row',
    paddingHorizontal: 2,
    paddingVertical: 12,
    minHeight: 70,
    gap: 12,
  },
  statusSlot: { paddingTop: 7 },
  sessionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sessionTitle: {
    color: c.text,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 22,
    flex: 1,
  },
  sessionMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  sessionFreshness: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 2,
  },
  sessionLastKnown: { color: c.faint, fontFamily: mono, fontSize: 12 },
  sessionAgent: { fontSize: 12, lineHeight: 18, fontWeight: '500' },
  sessionCwd: {
    flex: 1,
    minWidth: 0,
    color: c.faint,
    fontSize: 11,
    lineHeight: 18,
  },
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
  pressed: { backgroundColor: c.elevated },
  menuOverlay: { flex: 1, padding: 8, backgroundColor: '#00000099' },
  menu: {
    width: '90%',
    maxWidth: 360,
    maxHeight: '92%',
    flexShrink: 1,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: c.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
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
  menuScroll: { flexShrink: 1 },
  menuContent: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 12, gap: 4 },
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
  menuLabel: { color: c.text, fontFamily: mono, fontSize: 13, lineHeight: 21 },
  menuSessionRow: {
    flexDirection: 'row',
    gap: 12,
    minHeight: 68,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 4,
  },
  menuSession: {
    flex: 1,
    color: c.text,
    fontFamily: mono,
    fontSize: 12,
    lineHeight: 20,
    fontWeight: '500',
  },
  menuSessionMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  menuSessionGroup: {
    flex: 1,
    minWidth: 0,
    color: c.muted,
    fontFamily: mono,
    fontSize: 10,
    lineHeight: 17,
  },
  menuSessionCwd: { color: c.faint, fontFamily: mono, fontSize: 10, lineHeight: 16 },
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
