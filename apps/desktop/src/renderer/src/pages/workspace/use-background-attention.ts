import { useEffect, useRef } from 'react';
import {
  ATTENTION_MENU_SESSIONS,
  attentionSessionSchema,
  type DesktopAttention,
} from '@nesvo/contracts';
import type { Session } from '@/entities/session';
import { entityKey, hostKey } from '@/shared/lib/host-key';

const TITLE_LENGTH = 200;

function attentionOf(sessions: Session[], needsMe: Set<string>) {
  const waiting = sessions
    .filter(session => needsMe.has(entityKey(session)))
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    count: waiting.length,
    sessions: waiting
      .map(session => ({
        hostId: session.hostId,
        sessionId: session.id,
        title: session.title.slice(0, TITLE_LENGTH),
      }))
      .filter(entry => attentionSessionSchema.safeParse(entry).success)
      .slice(0, ATTENTION_MENU_SESSIONS),
  } satisfies DesktopAttention;
}

export function useBackgroundAttention(
  sessions: Session[],
  needsMe: Set<string>,
  onOpen: (key: string) => void,
) {
  const sent = useRef('');
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  });
  useEffect(() => {
    if (!window.nesvo) return;
    const attention = attentionOf(sessions, needsMe);
    const serialized = JSON.stringify(attention);
    if (serialized === sent.current) return;
    sent.current = serialized;
    void window.nesvo.setAttention(attention).catch(() => {
      sent.current = '';
    });
  }, [sessions, needsMe]);
  useEffect(() => {
    if (!window.nesvo) return;
    return window.nesvo.onOpenSession(target =>
      openRef.current(hostKey(target.sessionId, target.hostId)),
    );
  }, []);
}
