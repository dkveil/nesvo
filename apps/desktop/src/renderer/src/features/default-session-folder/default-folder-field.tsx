import { useState } from 'react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Field } from '@/shared/ui/field';
import { Input } from '@/shared/ui/input';

type Props = {
  id: string;
  computerName: string;
  value: string | null;
  supported: boolean;
  label?: string;
  onSave: (directory: string | null) => Promise<string | null>;
  className?: string;
};

export function DefaultFolderField({
  id,
  computerName,
  value,
  supported,
  label = 'Default session folder',
  onSave,
  className,
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const current = draft ?? value ?? '';
  const changed = current.trim() !== (value ?? '');
  const save = async (directory: string | null) => {
    setPending(true);
    setError('');
    try {
      await onSave(directory);
      setDraft(null);
    } catch (failure) {
      setError(errorDetail(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Field
      id={id}
      label={label}
      className={className}
      hint={
        supported
          ? `New sessions on ${computerName} start here when you give no location. Checked on ${computerName}.`
          : `Connect ${computerName} with an up-to-date host to set a default folder.`
      }
      messages={error ? [{ severity: 'error', message: error }] : []}
    >
      <form
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (changed) void save(current.trim() || null);
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
          disabled={!supported || pending || !changed}
        >
          {pending ? 'Checking…' : 'Save'}
        </Button>
        {value && !changed && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!supported || pending}
            onClick={() => void save(null)}
          >
            Clear
          </Button>
        )}
      </form>
    </Field>
  );
}
