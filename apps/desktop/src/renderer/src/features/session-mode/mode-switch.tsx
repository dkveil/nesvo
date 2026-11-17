import { useId, useRef, useState } from 'react';
import type { SessionMode } from '@nesvo/contracts';
import {
  ModeIcon,
  modeDescription,
  modeLabel,
  type Provider,
} from '@/entities/session';
import { ComposerChip } from '@/features/new-thread/composer-chip';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { SegmentedControl } from '@/shared/ui/segmented-control';

type Props = {
  provider: Provider;
  modes: SessionMode[];
  mode: SessionMode;
  pendingMode: SessionMode | null;
  disabled?: boolean;
  readOnlyReason?: string;
  onChange: (mode: SessionMode | null) => void;
};

export function ModeSwitch({
  provider,
  modes,
  mode,
  pendingMode,
  disabled = false,
  readOnlyReason = '',
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const browsing = useRef(false);
  const chosen = pendingMode ?? mode;
  const pending = chosen !== mode;
  const offered = modes.includes(mode) ? modes : [mode, ...modes];
  const label = modeLabel(provider, chosen);
  const choose = (next: SessionMode) => {
    if (readOnlyReason || !modes.includes(next)) return;
    onChange(next === mode ? null : next);
    if (!browsing.current) setOpen(false);
    browsing.current = false;
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Permission mode"
          title={`Permission mode: ${label}${pending ? ' · next turn' : ''}${readOnlyReason ? ` · ${readOnlyReason}` : ''}`}
          icon={<ModeIcon mode={chosen} aria-hidden="true" />}
          className="min-w-0"
        >
          <span>{label}</span>
          {pending && (
            <span className="shrink-0 text-muted-foreground">· next turn</span>
          )}
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        collisionPadding={12}
        aria-label="Permission mode"
        size="md"
        padding="none"
        className="space-y-2 p-2.5"
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setOpen(false);
        }}
      >
        <p className="text-xs font-medium text-muted-foreground">
          Permission mode
        </p>
        <div
          onKeyDownCapture={event => {
            browsing.current = event.key.startsWith('Arrow');
          }}
          onPointerDownCapture={() => {
            browsing.current = false;
          }}
        >
          <SegmentedControl
            label="Permission mode"
            size="md"
            fullWidth
            disabled={!!readOnlyReason}
            describedBy={descriptionId}
            value={chosen}
            onChange={choose}
            options={offered.map(candidate => ({
              value: candidate,
              label: modeLabel(provider, candidate),
              icon: <ModeIcon mode={candidate} aria-hidden="true" />,
              disabled: !modes.includes(candidate),
            }))}
          />
        </div>
        <div
          id={descriptionId}
          className="space-y-1 text-xs text-muted-foreground"
        >
          <p>{modeDescription(provider, chosen)}</p>
          <p role={readOnlyReason ? 'note' : undefined}>
            {readOnlyReason
              ? `${readOnlyReason}.`
              : 'Applies from the next turn. Shift+Tab cycles modes.'}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
