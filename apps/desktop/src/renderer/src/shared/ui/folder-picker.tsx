import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { Button } from '@/shared/ui/button';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { StatusMessage } from '@/shared/ui/status-message';

export function FolderPicker({
  id,
  value,
  chooseDirectory,
  onChange,
  disabled,
  describedBy,
  className,
}: {
  id: string;
  value: string | null;
  chooseDirectory: () => Promise<string | null>;
  onChange: (directory: string | null) => void | Promise<unknown>;
  disabled?: boolean;
  describedBy?: string;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const change = async (choose: boolean) => {
    setPending(true);
    setError('');
    try {
      const folder = choose ? await chooseDirectory() : null;
      if (!choose || folder !== null) await onChange(folder);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Could not change the folder.',
      );
    } finally {
      setPending(false);
    }
  };
  const pathId = `${id}-path`;
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
        <span id={pathId} className="min-w-0 text-xs text-muted-foreground">
          {value ? (
            <MiddleTruncatedText path value={value} />
          ) : (
            'No folder selected'
          )}
        </span>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-label="Choose folder…"
          aria-describedby={[pathId, describedBy].filter(Boolean).join(' ')}
          disabled={disabled || pending}
          onClick={() => void change(true)}
        >
          <FolderOpen />
          Choose folder…
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled || pending || !value}
          onClick={() => void change(false)}
        >
          Clear
        </Button>
      </div>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </div>
  );
}
