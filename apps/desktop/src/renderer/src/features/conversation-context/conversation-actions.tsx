import type { ReactNode } from 'react';
import { FoldVertical, MessageSquareText, RotateCcw } from 'lucide-react';
import type { Session } from '@/entities/session';

export type ConversationAction = {
  id: 'compact' | 'compact-with-instructions' | 'restart';
  label: string;
  icon: ReactNode;
  keywords: string;
  disabled: boolean;
  run: () => void;
};

type Params = {
  session: Session;
  canCompact: boolean;
  canRestart: boolean;
  busy: boolean;
  onCompact: () => void;
  onCompactWithInstructions: () => void;
  onRestart: () => void;
};

export function conversationActions({
  session,
  canCompact,
  canRestart,
  busy,
  onCompact,
  onCompactWithInstructions,
  onRestart,
}: Params): ConversationAction[] {
  const compactDisabled =
    busy || !session.providerInitialized || !!session.pendingClaudeFork;
  return [
    ...(canCompact
      ? [
          {
            id: 'compact' as const,
            label: 'Compact conversation',
            icon: <FoldVertical />,
            keywords: 'summarize context window shrink',
            disabled: compactDisabled,
            run: onCompact,
          },
          ...(session.provider === 'Claude Code'
            ? [
                {
                  id: 'compact-with-instructions' as const,
                  label: 'Compact with instructions…',
                  icon: <MessageSquareText />,
                  keywords: 'summarize context window focus keep',
                  disabled: compactDisabled,
                  run: onCompactWithInstructions,
                },
              ]
            : []),
        ]
      : []),
    ...(canRestart
      ? [
          {
            id: 'restart' as const,
            label: 'Restart session…',
            icon: <RotateCcw />,
            keywords: 'clear context fresh new thread reset',
            disabled: busy,
            run: onRestart,
          },
        ]
      : []),
  ];
}
