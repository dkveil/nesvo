import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { directoryLabel } from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { ComposerChip } from './composer-chip';

type Props = {
  directory: string;
  computerName: string;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (directory: string) => void;
};

type FormProps = {
  directory: string;
  computerName: string;
  onChange: (directory: string) => void;
  onDone: () => void;
};

function LocationForm({
  directory,
  computerName,
  onChange,
  onDone,
}: FormProps) {
  const [draft, setDraft] = useState(directory);
  const update = (value: string) => {
    setDraft(value);
    onChange(value.trim());
  };
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="thread-directory" className="text-xs">
          Working directory
        </Label>
        <Input
          id="thread-directory"
          aria-label="Working directory"
          placeholder="Absolute path, or leave blank"
          value={draft}
          autoFocus
          maxLength={4096}
          onChange={event => update(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onDone();
            }
          }}
          className="h-8 text-[13px]"
        />
        <p className="text-[11px] leading-5 text-muted-foreground">
          Any folder on {computerName}. A Git repository is not required. Leave
          it blank to start in an isolated folder.
        </p>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => {
            update('');
            onDone();
          }}
        >
          Use isolated folder
        </Button>
        <Button type="button" size="xs" onClick={onDone}>
          Done
        </Button>
      </div>
    </>
  );
}

export function LocationPicker({
  directory,
  computerName,
  disabled = false,
  open,
  onOpenChange,
  onChange,
}: Props) {
  const project = directory.trim() ? directoryLabel(directory.trim()) : '';
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Location"
          title={directory.trim() || 'Isolated folder on this computer'}
        >
          <FolderOpen />
          <span className="truncate">{project || 'Isolated folder'}</span>
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Location"
        className="w-[min(26rem,calc(100vw-1.5rem))] space-y-3 p-3"
      >
        <LocationForm
          directory={directory}
          computerName={computerName}
          onChange={onChange}
          onDone={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
