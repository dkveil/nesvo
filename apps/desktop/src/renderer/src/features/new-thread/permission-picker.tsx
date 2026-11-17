import { useId, useState } from 'react';
import type { CreateSessionInput } from '@nesvo/contracts';
import {
  ModeIcon,
  modeDescription,
  modeLabel,
  type Provider,
} from '@/entities/session';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { ComposerChip } from './composer-chip';

type Mode = CreateSessionInput['mode'];

type Props = {
  provider: Provider;
  modes: Mode[];
  mode: Mode;
  disabled?: boolean;
  onChange: (mode: Mode) => void;
};

const CLAUDE_READ_ONLY_REASON = 'Claude runs read-only analysis in Nesvo';

export function PermissionPicker({
  provider,
  modes,
  mode,
  disabled = false,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const planOnly =
    provider === 'Claude Code' && modes.every(option => option === 'read-only');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Permissions"
          icon={<ModeIcon mode={mode} aria-hidden="true" />}
        >
          <span>{modeLabel(provider, mode)}</span>
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        aria-label="Permissions"
        size="md"
        padding="sm"
        className="space-y-2 p-2.5"
      >
        <p className="text-xs font-medium text-muted-foreground">Permissions</p>
        <SegmentedControl
          label="Permission mode"
          size="md"
          fullWidth
          describedBy={descriptionId}
          value={mode}
          onChange={onChange}
          options={modes.map(option => ({
            value: option,
            label: modeLabel(provider, option),
            icon: <ModeIcon mode={option} aria-hidden="true" />,
          }))}
        />
        <div
          id={descriptionId}
          className="space-y-1 text-xs text-muted-foreground"
        >
          <p>{modeDescription(provider, mode)}</p>
          {planOnly && <p role="note">{CLAUDE_READ_ONLY_REASON}.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
