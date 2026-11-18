import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { StatusMessage } from '@/shared/ui/status-message';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Field, FieldLabel } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';

type Props = {
  id: string;
  computerName: string;
  value: string | null;
  supported: boolean;
  label?: string;
  onSave: (directory: string | null) => Promise<string | null>;
  chooseDirectory?: () => Promise<string | null>;
  className?: string;
};

export function DefaultFolderField({
  id,
  computerName,
  value,
  supported,
  label = 'Default session folder',
  onSave,
  chooseDirectory,
  className,
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const current = draft ?? value ?? '';
  const changed = current.trim() !== (value ?? '');
  const save = async (
    selection: () => Promise<string | null>,
    picking = false,
  ) => {
    setPending(true);
    setError('');
    try {
      const directory = await selection();
      if (picking && directory === null) return;
      await onSave(directory);
      setDraft(null);
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  const blocker = pending
    ? 'Finish choosing or saving the folder to use these controls.'
    : !supported
      ? 'Update the host to set a default session folder.'
      : '';
  if (chooseDirectory)
    return (
      <div className={className}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <FieldLabel id={id} as="span">
              {label}
            </FieldLabel>
            {value ? (
              <MiddleTruncatedText
                value={value}
                className="text-xs leading-5 text-muted-foreground"
              />
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">
                Use an isolated folder by default
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button
              variant="outline"
              disabled={!!blocker}
              aria-describedby={blocker ? `${id}-hint` : undefined}
              onClick={() => void save(chooseDirectory, true)}
            >
              <FolderOpen className="size-4" />
              {pending ? 'Checking…' : 'Choose folder'}
            </Button>
            {value && (
              <Button
                variant="ghost"
                disabled={!!blocker}
                aria-describedby={blocker ? `${id}-hint` : undefined}
                onClick={() => void save(async () => null)}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        {blocker && (
          <p id={`${id}-hint`} className="text-2xs text-muted-foreground">
            {blocker}
          </p>
        )}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </div>
    );
  return (
    <Field
      id={id}
      label={label}
      className={className}
      hint={blocker || 'Enter or change the path to save a default folder.'}
      messages={error ? [{ severity: 'error', message: error }] : []}
    >
      <form
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (changed) void save(async () => current.trim() || null);
        }}
      >
        <Input
          id={id}
          size="md"
          className="min-w-0 flex-1 font-mono"
          placeholder={`Absolute path on ${computerName}`}
          spellCheck={false}
          maxLength={4096}
          value={current}
          disabled={!supported || pending}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-messages` : `${id}-hint`}
          onChange={event => {
            setDraft(event.target.value);
            setError('');
          }}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!!blocker || !changed}
          aria-describedby={`${id}-hint`}
        >
          {pending ? 'Checking…' : 'Save'}
        </Button>
        {value && !changed && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!!blocker}
            aria-describedby={blocker ? `${id}-hint` : undefined}
            onClick={() => void save(async () => null)}
          >
            Clear
          </Button>
        )}
      </form>
    </Field>
  );
}
