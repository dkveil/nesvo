import { PathInput } from '@/shared/ui/path-input';
import { useState } from 'react';
import { errorDetail } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { FieldMessages } from '@/shared/ui/field';
import { FolderPicker } from '@/shared/ui/folder-picker';
import { SettingsRow } from '@/shared/ui/settings-section';

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
  const blocker = pending
    ? 'Saving the folder…'
    : !supported
      ? 'Update the host to set a default session folder.'
      : '';
  if (chooseDirectory)
    return (
      <SettingsRow
        title={<label htmlFor={id}>{label}</label>}
        className={className}
        description={
          blocker ? <span id={id + '-hint'}>{blocker}</span> : undefined
        }
      >
        <FolderPicker
          id={id}
          className="w-[min(24rem,36vw)]"
          value={value}
          chooseDirectory={chooseDirectory}
          onChange={onSave}
          disabled={!supported}
          describedBy={blocker ? id + '-hint' : undefined}
        />
      </SettingsRow>
    );
  return (
    <SettingsRow
      title={<label htmlFor={id}>{label}</label>}
      className={className}
      description={
        <div className="space-y-1">
          <p id={`${id}-hint`}>
            {blocker || 'Enter or change the path to save a default folder.'}
          </p>
          <FieldMessages
            id={`${id}-messages`}
            messages={error ? [{ severity: 'error', message: error }] : []}
          />
        </div>
      }
    >
      <form
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (changed) void save(current.trim() || null);
        }}
      >
        <PathInput
          id={id}
          size="md"
          containerClassName="w-[min(24rem,30vw)]"
          className="font-mono"
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
            onClick={() => void save(null)}
          >
            Clear
          </Button>
        )}
      </form>
    </SettingsRow>
  );
}
