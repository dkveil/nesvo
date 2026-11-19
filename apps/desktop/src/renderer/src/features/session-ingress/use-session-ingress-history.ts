import { useEffect, useState } from 'react';
import type {
  ExternalSessionMessageEntry,
  SessionIngressReceipt,
} from '@nesvo/contracts';

export const ingressStatus: Record<SessionIngressReceipt['status'], string> = {
  routing: 'Routing',
  queued: 'Queued for your next turn',
  notification: 'Notification',
  inbox: 'Waiting in Inbox',
  rejected: 'Rejected',
  dismissed: 'Dismissed',
  held: 'Held',
  delivering: 'In an active turn',
  delivered: 'Delivered',
  uncertain: 'Delivery uncertain',
};

export function useSessionIngressHistory(
  hostId: string,
  sessionId: string | undefined,
  enabled: boolean,
) {
  const key = hostId + ':' + sessionId;
  const [state, setState] = useState<{
    key: string;
    entries: ExternalSessionMessageEntry[];
  }>();
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let current = true;
    let pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await window.nesvo.externalSessionMessages(
          { action: 'history', sessionId },
          hostId,
        );
        if (current) setState({ key, entries: data.messages });
      } catch {
        if (current) setState({ key, entries: [] });
      } finally {
        pending = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [enabled, hostId, key, sessionId]);
  return enabled && state?.key === key ? state.entries : [];
}
