import { useState, type FormEvent } from 'react';
import type { Session } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';

type Props = {
  session: Session | null;
  onClose: () => void;
  onRename: (session: Session, title: string) => Promise<void>;
};

const TITLE_MAX_LENGTH = 100;
const FIELD_ID = 'rename-session-title';

function RenameForm({
  session,
  onClose,
  onRename,
}: Props & { session: Session }) {
  const [title, setTitle] = useState(session.title);
  const [pending, setPending] = useState(false);
  const trimmed = title.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || pending) return;
    if (trimmed === session.title) {
      onClose();
      return;
    }
    setPending(true);
    await onRename(session, trimmed);
    setPending(false);
    onClose();
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename session</DialogTitle>
        <DialogDescription>
          The provider conversation, folder and permissions stay the same.
        </DialogDescription>
      </DialogHeader>
      <Field id={FIELD_ID} label="Session name">
        <Input
          id={FIELD_ID}
          size="lg"
          autoFocus
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          onFocus={event => event.currentTarget.select()}
          onChange={event => setTitle(event.target.value)}
          aria-invalid={!trimmed || undefined}
        />
      </Field>
      <DialogFooter>
        <Button
          type="button"
          size="lg"
          variant="ghost"
          disabled={pending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button type="submit" size="lg" disabled={!trimmed || pending}>
          {pending ? 'Renaming…' : 'Rename session'}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function RenameSessionDialog({ session, onClose, onRename }: Props) {
  return (
    <Dialog open={!!session} onOpenChange={open => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {session && (
          <RenameForm
            key={session.id}
            session={session}
            onClose={onClose}
            onRename={onRename}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
