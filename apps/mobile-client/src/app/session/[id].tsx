import { useRef } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import type { DesktopSession } from '@nesvo/contracts';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Action, colors, Notice, styles } from '@/components/ui';
import { TurnActivity } from '@/components/turn-activity';
import { useMobileWorkspace } from '@/hooks/mobile-workspace';

export default function ConversationScreen() {
  const { id, hostId } = useLocalSearchParams<{ id: string; hostId: string }>();
  const store = useMobileWorkspace();
  const list = useRef<FlatList<DesktopSession['messages'][number]>>(null);
  const nearBottom = useRef(true);
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const session = store.view?.sessions.find(
    item => item.id === id && item.hostId === hostId,
  );
  const computer = store.view?.computers.find(item => item.id === hostId);
  if (!session)
    return (
      <View style={[styles.screen, styles.content]}>
        <Notice>
          {store.status === 'connecting'
            ? 'Loading conversation…'
            : 'This conversation is not available in the current snapshot.'}
        </Notice>
        <Action
          label="Back to sessions"
          onPress={() =>
            router.replace({
              pathname: '/computer/[id]',
              params: { id: hostId },
            })
          }
        />
      </View>
    );
  const ready = store.ready(hostId);
  const key = store.sessionKey(hostId, id);
  const running = session.status === 'running' || session.status === 'stopping';
  const children =
    store.view?.sessions.filter(
      item => item.hostId === hostId && item.parentId === id,
    ) ?? [];
  const group =
    !session.parentId &&
    (session.delegations.some(
      item =>
        item.runId === session.runId &&
        (item.status === 'pending' || item.childSessionId),
    ) ||
      children.some(item => item.parentRunId === session.runId));
  const firstAgents = new Map<string, string>();
  for (const message of session.messages)
    if (message.author === 'agent' && !firstAgents.has(message.runId))
      firstAgents.set(message.runId, message.id);
  const decisionKey = (requestId: string) =>
    `${key}/${session.runId}/${requestId}`;
  const footer = (
    <View style={{ gap: 16, paddingBottom: 12 }}>
      {session.pendingApprovals.map(approval => (
        <View
          key={`${session.runId}/${approval.id}`}
          style={styles.card}
          testID={`approval-${approval.id}`}
        >
          <Text style={styles.muted}>
            {approval.kind === 'command' ? 'Command approval' : 'File approval'}
          </Text>
          <Text selectable style={styles.body}>
            {approval.title}
          </Text>
          <Text selectable style={styles.muted}>
            {approval.detail}
          </Text>
          <Text selectable style={styles.muted}>
            Working directory: {approval.directory ?? session.directory}
          </Text>
          <View style={styles.actions}>
            <Action
              label="Allow once"
              testID="allow-once"
              disabled={
                !ready ||
                session.status !== 'running' ||
                !!store.pending[decisionKey(approval.id)]
              }
              onPress={() =>
                void store.act(
                  session,
                  'respond-approval',
                  approval.id,
                  'accept',
                )
              }
            />
            <Action
              label="Deny"
              testID="deny"
              secondary
              disabled={
                !ready ||
                session.status !== 'running' ||
                !!store.pending[decisionKey(approval.id)]
              }
              onPress={() =>
                void store.act(
                  session,
                  'respond-approval',
                  approval.id,
                  'decline',
                )
              }
            />
          </View>
          {store.errors[decisionKey(approval.id)] && (
            <Notice error>{store.errors[decisionKey(approval.id)]}</Notice>
          )}
        </View>
      ))}
      {session.delegations
        .filter(
          item => item.runId === session.runId && item.status === 'pending',
        )
        .map(delegation => (
          <View
            key={delegation.id}
            style={styles.card}
            testID={`delegation-${delegation.id}`}
          >
            <Text style={styles.muted}>Worker proposal</Text>
            <Text selectable style={styles.body}>
              {delegation.title}
            </Text>
            <Text selectable style={styles.body}>
              {delegation.task}
            </Text>
            <Text selectable style={styles.muted}>
              Scope: {delegation.scope}
              {'\n'}Directory: {delegation.directory}
              {'\n'}
              {delegation.provider} · {delegation.model} ·{' '}
              {delegation.mode === 'read-only'
                ? 'Read-only'
                : 'Workspace edits'}
            </Text>
            <View style={styles.actions}>
              <Action
                label="Approve worker"
                testID="approve-worker"
                disabled={
                  !ready ||
                  session.status !== 'running' ||
                  !!store.pending[decisionKey(delegation.id)]
                }
                onPress={() =>
                  void store.act(
                    session,
                    'decide-delegation',
                    delegation.id,
                    'accept',
                  )
                }
              />
              <Action
                label="Decline"
                testID="decline-worker"
                secondary
                disabled={
                  !ready ||
                  session.status !== 'running' ||
                  !!store.pending[decisionKey(delegation.id)]
                }
                onPress={() =>
                  void store.act(
                    session,
                    'decide-delegation',
                    delegation.id,
                    'decline',
                  )
                }
              />
            </View>
            {store.errors[decisionKey(delegation.id)] && (
              <Notice error>{store.errors[decisionKey(delegation.id)]}</Notice>
            )}
          </View>
        ))}
      {children.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={styles.muted}>
            Workers on {computer?.name ?? 'this computer'}
          </Text>
          {children.map(child => (
            <Action
              key={child.id}
              label={`Open worker: ${child.title}`}
              secondary
              onPress={() =>
                router.push({
                  pathname: '/session/[id]',
                  params: { id: child.id, hostId },
                })
              }
            />
          ))}
        </View>
      )}
      {session.error && <Notice error>{session.error}</Notice>}
      {store.errors[key] && <Notice error>{store.errors[key]}</Notice>}
      {store.errors[decisionKey('stop')] && (
        <Notice error>{store.errors[decisionKey('stop')]}</Notice>
      )}
    </View>
  );
  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen options={{ title: session.title }} />
      <FlatList
        ref={list}
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        data={session.messages}
        keyExtractor={message => message.id}
        testID="conversation-list"
        keyboardShouldPersistTaps="handled"
        onScroll={event => {
          const { contentOffset, contentSize, layoutMeasurement } =
            event.nativeEvent;
          nearBottom.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height <
            100;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (nearBottom.current)
            list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          <View style={{ gap: 10, paddingBottom: 14 }}>
            <View style={styles.actions}>
              <Action
                label="Back to sessions"
                secondary
                onPress={() =>
                  router.replace({
                    pathname: '/computer/[id]',
                    params: { id: hostId },
                  })
                }
              />
              {session.parentId && (
                <Action
                  label="Open parent session"
                  secondary
                  onPress={() =>
                    router.replace({
                      pathname: '/session/[id]',
                      params: { id: session.parentId!, hostId },
                    })
                  }
                />
              )}
            </View>
            <Text selectable style={styles.muted}>
              {computer?.name ?? 'Computer'} · {session.provider} ·{' '}
              {session.actualModel ?? session.model} ·{' '}
              {session.mode === 'read-only' ? 'Read-only' : 'Workspace edits'}
            </Text>
            {!ready && (
              <>
                <Notice error>
                  {store.error ||
                    'Offline snapshot. Work may still be running. Messages and decisions are disabled until the connection is refreshed.'}
                </Notice>
                <Action
                  label="Reconnect"
                  secondary
                  disabled={
                    store.status === 'connecting' ||
                    store.status === 'revoked' ||
                    store.status === 'unauthorized'
                  }
                  onPress={store.reconnect}
                />
              </>
            )}
          </View>
        }
        renderItem={({ item }) => {
          const activities =
            firstAgents.get(item.runId) === item.id
              ? session.activities.filter(
                  activity => activity.runId === item.runId,
                )
              : [];
          const start = session.messages.find(
            message =>
              message.author === 'operator' && message.runId === item.runId,
          )?.createdAt;
          const seconds =
            item.completedAt && start
              ? Math.max(
                  0,
                  Math.round(
                    (Date.parse(item.completedAt) - Date.parse(start)) / 1000,
                  ),
                )
              : null;
          return (
            <View
              style={{ gap: 8, paddingBottom: 28 }}
              testID={`message-${item.id}`}
            >
              <Text style={styles.muted}>
                {item.author === 'operator' ? 'You' : session.provider}
                {item.author === 'agent' && seconds !== null
                  ? ` · ${item.state === 'stopped' ? 'Stopped after' : item.state === 'failed' ? 'Failed after' : item.state === 'interrupted' ? 'Interrupted after' : 'Worked for'} ${seconds}s`
                  : ''}
              </Text>
              {item.skill && (
                <Text selectable style={styles.muted}>
                  Requested skill: {item.skill.name}
                  {item.skill.delivery === 'instructions'
                    ? ' · Shared instructions'
                    : ''}
                </Text>
              )}
              <TurnActivity items={activities} />
              {session.activityTruncatedRunIds.includes(item.runId) &&
                firstAgents.get(item.runId) === item.id && (
                  <Notice>Some activity was omitted from saved history.</Notice>
                )}
              <Text selectable style={styles.body}>
                {item.body ||
                  (running && item.runId === session.runId
                    ? ready
                      ? 'Waiting for response…'
                      : 'No response text in the last snapshot.'
                    : 'No response text.')}
              </Text>
            </View>
          );
        }}
        ListFooterComponent={footer}
        ListEmptyComponent={
          <Notice>
            No messages yet. Send a message to continue this saved session.
          </Notice>
        }
      />
      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 12),
          gap: 10,
          borderTopWidth: 1,
          borderColor: colors.border,
        }}
      >
        <TextInput
          accessibilityLabel="Message"
          testID="message-input"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          maxLength={32000}
          value={store.draft(hostId, id)}
          onChangeText={text => store.changeDraft(hostId, id, text)}
          placeholder="Message this session…"
          placeholderTextColor={colors.muted}
          style={[styles.input, { maxHeight: 120, minHeight: 60 }]}
        />
        <View style={styles.actions}>
          {running ? (
            <Action
              label={
                session.status === 'stopping'
                  ? 'Stopping…'
                  : group
                    ? 'Stop group'
                    : 'Stop'
              }
              testID="stop-run"
              disabled={
                !ready ||
                session.status === 'stopping' ||
                !!store.pending[decisionKey('stop')]
              }
              onPress={() => void store.act(session, 'stop-run')}
            />
          ) : (
            <Action
              label={store.pending[key] ? 'Sending…' : 'Send message'}
              testID="send-message"
              disabled={
                !ready ||
                !!store.pending[key] ||
                !store.draft(hostId, id).trim()
              }
              onPress={() => {
                nearBottom.current = true;
                list.current?.scrollToEnd({ animated: false });
                void store.send(session);
              }}
            />
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
