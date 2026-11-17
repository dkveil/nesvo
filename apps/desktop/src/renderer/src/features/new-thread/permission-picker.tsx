import { useState, type KeyboardEvent } from 'react';
import type { CreateSessionInput } from '@nesvo/contracts';
import { cn } from 'cn';
import {
  ModeIcon,
  modeDescription,
  modeLabel,
  type Provider,
} from '@/entities/session';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
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
  const [previewMode, setPreviewMode] = useState<Mode | null>(null);
  const shown = previewMode ?? mode;
  const planOnly =
    provider === 'Claude Code' && modes.every(option => option === 'read-only');
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = modes.indexOf(mode);
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = modes[(index + offset + modes.length) % modes.length];
    if (next) {
      onChange(next);
      document.getElementById(`thread-mode-${next}`)?.focus();
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        setPreviewMode(null);
      }}
    >
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Permissions"
          title={`Permissions: ${modeLabel(provider, mode)}`}
        >
          <ModeIcon mode={mode} />
          <span>{modeLabel(provider, mode)}</span>
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Permissions"
        className="w-62 space-y-2.5 p-2.5"
      >
        <p className="text-xs font-medium text-muted-foreground">Permissions</p>
        <div
          role="radiogroup"
          aria-label="Permission mode"
          className={cn(
            'grid gap-1 rounded-lg bg-segment-track p-1',
            modes.length === 1 && 'grid-cols-1',
            modes.length === 2 && 'grid-cols-2',
            modes.length >= 3 && 'grid-cols-3',
          )}
          onPointerLeave={() => setPreviewMode(null)}
        >
          {modes.map(option => {
            const checked = option === mode;
            return (
              <button
                key={option}
                id={`thread-mode-${option}`}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={modeLabel(provider, option)}
                title={modeLabel(provider, option)}
                tabIndex={checked ? 0 : -1}
                onKeyDown={onKeyDown}
                onPointerEnter={() => setPreviewMode(option)}
                onFocus={() => setPreviewMode(option)}
                onBlur={() => setPreviewMode(null)}
                onClick={() => onChange(option)}
                className={cn(
                  'flex h-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 outline-none',
                  'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  checked && 'bg-segment-active text-foreground shadow-xs',
                )}
              >
                <ModeIcon
                  mode={option}
                  className="size-3.5"
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        <div className="space-y-0.5" aria-live="polite">
          <p className="text-sm font-semibold">{modeLabel(provider, shown)}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {modeDescription(provider, shown)}
          </p>
          {planOnly && (
            <p role="note" className="text-xs leading-5 text-muted-foreground">
              {CLAUDE_READ_ONLY_REASON}.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
