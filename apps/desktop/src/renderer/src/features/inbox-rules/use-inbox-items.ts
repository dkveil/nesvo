import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Computer,
  DecideInboxItemInput,
  DecisionRoute,
  InboxItem,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { hostKey } from '@/shared/lib/host-key';

export type HostedInboxItem = InboxItem & { hostId: string };

export type InboxItemDecision = Omit<DecideInboxItemInput, 'itemId'>;

const isReady = (computer: Computer) =>
  computer.status === 'connected' &&
  computer.capabilities.includes('inbox-rules');

export const inboxItemKey = (item: Pick<HostedInboxItem, 'id' | 'hostId'>) =>
  hostKey(item.id, item.hostId);

export function useInboxItems(computers: Computer[]) {
  const [items, setItems] = useState<HostedInboxItem[]>([]);
  const [routes, setRoutes] = useState<Record<string, DecisionRoute>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const loaded = useRef(new Set<string>());
  const merge = useCallback((updates: HostedInboxItem[]) => {
    setItems(previous => {
      const merged = new Map(previous.map(item => [inboxItemKey(item), item]));
      for (const item of updates) merged.set(inboxItemKey(item), item);
      return [...merged.values()].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt),
      );
    });
  }, []);
  const load = useCallback(
    async (hostId: string) => {
      const api = window.nesvo;
      if (!api) return;
      try {
        const [listed, settings] = await Promise.all([
          api.listInboxItems(hostId),
          api.readInboxSettings(hostId),
        ]);
        merge(listed.map(item => ({ ...item, hostId })));
        setRoutes(previous => ({
          ...previous,
          [hostId]: settings.defaultRoute,
        }));
      } catch {
        loaded.current.delete(hostId);
      }
    },
    [merge],
  );
  useEffect(() => {
    const ready = computers.filter(isReady).map(computer => computer.id);
    for (const hostId of ready)
      if (!loaded.current.has(hostId)) {
        loaded.current.add(hostId);
        void load(hostId);
      }
    for (const hostId of [...loaded.current])
      if (!ready.includes(hostId)) loaded.current.delete(hostId);
  }, [computers, load]);
  useEffect(() => {
    const api = window.nesvo;
    if (!api) return;
    return api.subscribe(event => {
      if (event.type === 'inbox-item-changed')
        merge([{ ...event.item, hostId: event.hostId }]);
      else if (event.type === 'host-disconnected')
        loaded.current.delete(event.hostId);
    });
  }, [merge]);
  const decide = useCallback(
    async (item: HostedInboxItem, decision: InboxItemDecision) => {
      const api = window.nesvo;
      const key = inboxItemKey(item);
      if (!api) return;
      setPending(previous => ({ ...previous, [key]: true }));
      setErrors(previous => ({ ...previous, [key]: '' }));
      try {
        const decided = await api.decideInboxItem(
          { ...decision, itemId: item.id },
          item.hostId,
        );
        merge([{ ...decided, hostId: item.hostId }]);
      } catch (failure) {
        setErrors(previous => ({
          ...previous,
          [key]: `Could not send the decision. ${errorDetail(failure)}`,
        }));
      } finally {
        setPending(previous => ({ ...previous, [key]: false }));
      }
    },
    [merge],
  );
  const saveDefaultRoute = useCallback(
    async (hostId: string, route: DecisionRoute) => {
      const api = window.nesvo;
      if (!api) return;
      const settings = await api.saveInboxSettings(
        { defaultRoute: route },
        hostId,
      );
      setRoutes(previous => ({ ...previous, [hostId]: settings.defaultRoute }));
    },
    [],
  );
  return {
    items,
    defaultRoute: (hostId: string): DecisionRoute => routes[hostId] ?? 'inbox',
    saveDefaultRoute,
    pending,
    errors,
    decide,
    reload: load,
  };
}

export type InboxItems = ReturnType<typeof useInboxItems>;
