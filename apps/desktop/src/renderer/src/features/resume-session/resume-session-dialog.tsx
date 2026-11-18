import { useId, useState } from 'react';
import {
  resumeContinuationText,
  sessionResumeBlocker,
  sessionResumeBlockerMessages,
} from '@nesvo/contracts';
import type { Session } from '@/entities/session';
import { ConfirmDialog } from '@/shared/ui/confirm-dialog';
import { Field } from '@/shared/ui/field';
import { InlineNotice } from '@/shared/ui/inline-notice';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

type Props = {
  session: Session;
  error: string;
  onResume: (text: string) => Promise<boolean>;
  onRestart: () => void;
  onClose: () => void;
};

const RESUME_TEXT_LIMIT = 32000;

export function ResumeSessionDialog({
  session,
  error,
  onResume,
  onRestart,
  onClose,
}: Props) {
  const id = useId();
  const [text, setText] = useState(() => resumeContinuationText(session));
  const trimmed = text.trim();
  const blocker = sessionResumeBlocker(session);
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  if (blocker === 'no-thread')
    return (
      <ConfirmDialog
        open
        onOpenChange={close}
        title="This session cannot be resumed"
        description={sessionResumeBlockerMessages['no-thread']}
        confirmLabel="Restart session…"
        tone="default"
        onConfirm={onRestart}
      />
    );
  return (
    <ConfirmDialog
      open
      onOpenChange={close}
      title="Resume session"
      description={`Nesvo sends this message to the same ${session.provider} conversation of “${session.title}”, in the same folder, group and permission mode. Nothing runs until you resume. Restart instead starts a fresh conversation.`}
      confirmLabel="Resume"
      pendingLabel="Resuming…"
      confirmDisabled={!trimmed || !!blocker}
      tone="default"
      onConfirm={() => (trimmed ? onResume(trimmed) : false)}
    >
      <div data-resume-session={session.id} className="space-y-3">
        <Field id={id} label="Continuation message">
          <Textarea
            id={id}
            value={text}
            maxLength={RESUME_TEXT_LIMIT}
            rows={4}
            onChange={event => setText(event.target.value)}
          />
        </Field>
        {blocker && (
          <InlineNotice tone="warning">
            {sessionResumeBlockerMessages[blocker]}
          </InlineNotice>
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </div>
    </ConfirmDialog>
  );
}
