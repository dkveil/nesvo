import { useCallback, useEffect, useRef, useState } from 'react';

import { useWorkspace } from '@entities/workspace';

import type { InboxItem } from '@shared/api/host';

import {
  groupInboxItems,
  INBOX_PAGE_LIMIT,
  markKey,
  mergeInboxPage,
  refreshLimit,
  restoreItems,
  withoutItems,
} from './inbox-items';

const CHANGE_DEBOUNCE_MS = 400;

type InboxStatus = 'idle' | 'loading' | 'ready' | 'error';
type InboxSnapshot = {
  items: InboxItem[];
  total: number;
  nextPage: number | null;
  limit: number;
  receivedAt: number | null;
};
type InboxSupport = { inbox: boolean; decisions: boolean };
type PageRequest = { id: string; replace: boolean };

const EMPTY_SNAPSHOT: InboxSnapshot = {
  items: [],
  total: 0,
  nextPage: null,
  limit: INBOX_PAGE_LIMIT,
  receivedAt: null,
};
const NO_SUPPORT: InboxSupport = { inbox: false, decisions: false };

export const useInboxState = () => {
  const { client, connected, mode, pairing } = useWorkspace();
  const [snapshot, setSnapshot] = useState<InboxSnapshot>(EMPTY_SNAPSHOT);
  const [status, setStatus] = useState<InboxStatus>('idle');
  const [notice, setNotice] = useState('');
  const [support, setSupport] = useState<InboxSupport>(NO_SUPPORT);
  const snapshotRef = useRef(snapshot);
  const pageRequest = useRef<PageRequest | null>(null);
  const acknowledgements = useRef(new Map<string, InboxItem[]>());
  const hiddenMarks = useRef(new Set<string>());
  const changeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastHost = useRef<string | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const reset = useCallback(() => {
    clearTimeout(changeTimer.current);
    pageRequest.current = null;
    acknowledgements.current.clear();
    hiddenMarks.current.clear();
    setSnapshot(EMPTY_SNAPSHOT);
    setStatus('idle');
    setNotice('');
  }, []);

  const refresh = useCallback(() => {
    const requestId = client.requestId();
    pageRequest.current = { id: requestId, replace: true };
    setStatus('loading');
    const sent = client.requestAttentionInbox(
      0,
      refreshLimit(snapshotRef.current.items.length),
      requestId,
    );
    if (sent) return;
    pageRequest.current = null;
    setStatus(snapshotRef.current.receivedAt === null ? 'idle' : 'ready');
  }, [client]);

  const loadMore = useCallback(() => {
    const { nextPage, limit } = snapshotRef.current;
    if (nextPage === null || pageRequest.current) return;
    const requestId = client.requestId();
    pageRequest.current = { id: requestId, replace: false };
    if (!client.requestAttentionInbox(nextPage, limit, requestId)) pageRequest.current = null;
  }, [client]);

  const rollback = useCallback((requestId: string, message: string) => {
    const removed = acknowledgements.current.get(requestId);
    if (!removed) return;
    acknowledgements.current.delete(requestId);
    for (const item of removed) hiddenMarks.current.delete(markKey(item));
    setSnapshot(current => ({
      ...current,
      items: restoreItems(current.items, removed),
      total: current.total + removed.length,
    }));
    setNotice(message);
  }, []);

  const acknowledge = useCallback(
    (item: InboxItem) => {
      const requestId = client.requestId();
      acknowledgements.current.set(requestId, [item]);
      hiddenMarks.current.add(markKey(item));
      setSnapshot(current => ({
        ...current,
        items: withoutItems(current.items, [item]),
        total: Math.max(0, current.total - 1),
      }));
      setNotice('');
      const sent = client.acknowledgeInbox([{ id: item.id, revision: item.revision }], requestId);
      if (!sent) rollback(requestId, 'Not connected to the host. The item stays in the inbox.');
    },
    [client, rollback],
  );

  useEffect(
    () =>
      client.subscribe(event => {
        if (event.type === 'attentionInbox') {
          const request = pageRequest.current;
          if (!request || event.requestId !== request.id) return;
          pageRequest.current = null;
          setSnapshot(current => ({
            items: mergeInboxPage(current.items, event.items, request.replace, hiddenMarks.current),
            total: event.total,
            nextPage: event.nextPage,
            limit: event.limit,
            receivedAt: Date.now(),
          }));
          setStatus('ready');
        } else if (event.type === 'capabilities') {
          const host = event.hostId ?? '';
          if (lastHost.current !== host) {
            lastHost.current = host;
            reset();
          }
          const next = {
            inbox: event.attentionInbox === true,
            decisions: event.decisions === true,
          };
          setSupport(next);
          if (next.inbox) refresh();
          else reset();
        } else if (event.type === 'inboxAcknowledged') {
          if (event.requestId) acknowledgements.current.delete(event.requestId);
        } else if (event.type === 'attentionInboxChanged') {
          clearTimeout(changeTimer.current);
          changeTimer.current = setTimeout(refresh, CHANGE_DEBOUNCE_MS);
        } else if (event.type === 'error' && event.requestId) {
          if (event.requestId === pageRequest.current?.id) {
            pageRequest.current = null;
            setStatus('error');
            setNotice(event.message);
          } else {
            rollback(event.requestId, `The host refused the acknowledgement: ${event.message}`);
          }
        } else if (event.type === 'disconnected') {
          clearTimeout(changeTimer.current);
          pageRequest.current = null;
          setStatus(snapshotRef.current.receivedAt === null ? 'idle' : 'ready');
          for (const requestId of [...acknowledgements.current.keys()])
            rollback(
              requestId,
              'The connection dropped before confirmation. The inbox refreshes after reconnecting.',
            );
        }
      }),
    [client, refresh, rollback, reset],
  );

  useEffect(() => () => clearTimeout(changeTimer.current), []);

  const visible = mode === 'live' && !!pairing;
  const items = visible ? snapshot.items : EMPTY_SNAPSHOT.items;

  return {
    supported: visible && support.inbox,
    decisionsSupported: visible && support.decisions,
    connected,
    items,
    sections: groupInboxItems(items),
    total: visible ? snapshot.total : 0,
    nextPage: visible ? snapshot.nextPage : null,
    receivedAt: visible ? snapshot.receivedAt : null,
    loading: status === 'loading',
    failed: status === 'error',
    notice,
    dismissNotice: () => setNotice(''),
    refresh,
    loadMore,
    acknowledge,
  };
};
