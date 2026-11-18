import type { ReactNode } from 'react';
import { FoldVertical, MessageSquareText, Play, RotateCcw } from 'lucide-react';
import { resumableSessionStates } from '@nesvo/contracts';
import type { Session } from '@/entities/session';

export type ConversationAction = {
  id: 'resume' | 'compact' | 'compact-with-instructions' | 'restart';
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
  canResume: boolean;
  busy: boolean;
  onResume: () => void;
  onCompact: () => void;
  onCompactWithInstructions: () => void;
  onRestart: () => void;
};

export function conversationActions({
  session,
  canCompact,
  canRestart,
  canResume,
  busy,
  onResume,
  onCompact,
  onCompactWithInstructions,
  onRestart,
}: Params): ConversationAction[] {
  const compactDisabled =
    busy || !session.providerInitialized || !!session.pendingClaudeFork;
  const resumable = (resumableSessionStates as readonly string[]).includes(
    session.status,
  );
  return [
    ...(canResume && resumable
      ? [
          {
            id: 'resume' as const,
            label: 'Resume…',
            icon: <Play />,
            keywords: 'continue retry failed interrupted stopped same thread',
            disabled: busy,
            run: onResume,
          },
        ]
      : []),
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
