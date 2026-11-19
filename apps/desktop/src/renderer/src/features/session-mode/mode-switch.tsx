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
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { StatusDot } from '@/shared/ui/status-dot';
import { Hint } from '@/shared/ui/tooltip';

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
  const offered =
    modes.includes(mode) || mode === 'full-access' ? modes : [mode, ...modes];
  const label = modeLabel(provider, chosen);
  const choose = (next: SessionMode) => {
    if (readOnlyReason || !modes.includes(next)) return;
    onChange(next === mode ? null : next);
    if (!browsing.current) setOpen(false);
    browsing.current = false;
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint
        label={`Permission mode: ${label}${pending ? ' · next turn' : ''}${readOnlyReason ? ` · ${readOnlyReason}` : ''}`}
      >
        <PopoverTrigger asChild>
          <ComposerChip
            disabled={disabled}
            aria-label="Permission mode"
            size="sm"
            data-pending={pending || undefined}
            icon={<ModeIcon mode={chosen} aria-hidden="true" />}
            className="min-w-0"
          >
            {chosen === 'full-access' ? (
              <Badge size="sm" tone="warning" className="text-xs">
                {label}
              </Badge>
            ) : (
              <span>{label}</span>
            )}
            {pending && (
              <span className="inline-flex shrink-0 items-center gap-1 text-info-foreground">
                <StatusDot tone="info" label="Applies next turn" />
                <span className="text-2xs">Next turn</span>
              </span>
            )}
          </ComposerChip>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        surface="solid"
        side="top"
        align="start"
        collisionPadding={12}
        aria-label="Permission mode"
        size={modes.includes('full-access') ? 'lg' : 'md'}
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
            className="[&_[role=radio]]:text-foreground [&_[role=radio][aria-checked=true]]:font-semibold"
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
          <p className="text-ui text-foreground">
            {modeDescription(provider, chosen)}
          </p>
          <p className="text-2xs" role={readOnlyReason ? 'note' : undefined}>
            {readOnlyReason
              ? `${readOnlyReason}.`
              : 'Applies from the next turn. Shift+Tab cycles modes.'}
          </p>
        </div>
        {mode === 'full-access' &&
          modes.includes('full-access') &&
          !pending &&
          !readOnlyReason && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setOpen(false);
                onChange('full-access');
              }}
            >
              Confirm Full access again
            </Button>
          )}
      </PopoverContent>
    </Popover>
  );
}
