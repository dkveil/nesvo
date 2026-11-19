import { useState } from 'react';
import {
  claudePlanHookDefinitionSchema,
  type ReadonlyIntegrationReply,
  type Session,
} from '@nesvo/contracts';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { CodeBlock } from '@/shared/ui/code-block';
import {
  Dialog,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import { StatusMessage } from '@/shared/ui/status-message';
import { Textarea } from '@/shared/ui/textarea';

const example = JSON.stringify(
  {
    name: '',
    matcher: 'startup',
    command: { executable: '', argv: [], files: [], timeoutMs: 10000 },
  },
  null,
  2,
);
type Review = Extract<
  ReadonlyIntegrationReply,
  { action: 'inspect-hook' }
>['hook'];

export function ClaudePlanHookDialog({
  hostId,
  sessions,
  onSaved,
}: {
  hostId: string;
  sessions: Pick<Session, 'id' | 'title'>[];
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [source, setSource] = useState(example);
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const definition = claudePlanHookDefinitionSchema.parse(
        JSON.parse(source),
      );
      const reply = await window.nesvo.readonlyIntegrationGrants(
        review
          ? {
              action: 'approve-hook',
              sessionId,
              definition,
              revision: review.revision,
              actionId: crypto.randomUUID(),
            }
          : { action: 'inspect-hook', sessionId, definition },
        hostId,
      );
      if (reply.action === 'inspect-hook') setReview(reply.hook);
      if (reply.action === 'approve-hook') {
        await onSaved();
        setOpen(false);
      }
    } catch (reason) {
      setError(errorDetail(reason));
      setReview(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (busy) return;
        setOpen(next);
        setSessionId(sessions[0]?.id ?? '');
        setSource(example);
        setReview(undefined);
        setError('');
      }}
    >
      <DialogTrigger asChild>
        <Button variant="secondary" size="xs" disabled={!sessions.length}>
          Add SessionStart hook
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {review ? 'Review SessionStart command' : 'Add SessionStart hook'}
          </DialogTitle>
          <DialogDescription>
            Claude runs the approved command with its process permissions
            outside per-operation approval.
          </DialogDescription>
        </DialogHeader>
        {review ? (
          <CodeBlock code={JSON.stringify(review, null, 2)} wrap />
        ) : (
          <>
            <Field id="plan-hook-session" label="Claude Code session">
              <Select value={sessionId} onValueChange={setSessionId}>
                <SelectTrigger id="plan-hook-session">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sessions.map(session => (
                    <SelectItem key={session.id} value={session.id}>
                      {session.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              id="plan-hook-definition"
              label="Hook definition"
              hint="Use the executable's absolute path, fixed arguments and the script files to verify. An empty matcher applies to every SessionStart reason."
            >
              <Textarea
                id="plan-hook-definition"
                rows={9}
                className="resize-none font-mono"
                value={source}
                onChange={event => setSource(event.target.value)}
              />
            </Field>
          </>
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        <DialogFooter>
          <DialogCancel disabled={busy} />
          <Button
            size="lg"
            disabled={busy || !sessionId}
            onClick={() => void submit()}
          >
            {review ? 'Approve hook' : 'Review command'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
