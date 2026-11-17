import { useId, useState, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import type { SessionMode } from '@nesvo/contracts';
import { cn } from 'cn';
import {
  ModeIcon,
  modeDescription,
  modeLabel,
  type Provider,
} from '@/entities/session';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { ComposerChip } from '@/features/new-thread/composer-chip';

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
  const idPrefix = useId();
  const chosen = pendingMode ?? mode;
  const pending = chosen !== mode;
  const offered = modes.includes(mode) ? modes : [mode, ...modes];
  const label = modeLabel(provider, chosen);
  const radioId = (candidate: SessionMode) => `${idPrefix}-${candidate}`;
  const choose = (next: SessionMode) => {
    if (readOnlyReason || !modes.includes(next)) return;
    onChange(next === mode ? null : next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (readOnlyReason) return;
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    if (!forward && !backward) return;
    event.preventDefault();
    const index = modes.indexOf(chosen);
    const offset = forward ? 1 : -1;
    const next = modes[(index + offset + modes.length) % modes.length];
    if (!next) return;
    choose(next);
    document.getElementById(radioId(next))?.focus();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Permission mode"
          title={`Permission mode: ${label}${pending ? ' · next turn' : ''}${readOnlyReason ? ` · ${readOnlyReason}` : ''}`}
          className="min-w-0"
        >
          <ModeIcon mode={chosen} aria-hidden="true" />
          <span className="truncate">{label}</span>
          {pending && (
            <span className="shrink-0 text-muted-foreground/70">
              · next turn
            </span>
          )}
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Permission mode"
        className="w-72 space-y-2 p-1.5"
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setOpen(false);
        }}
      >
        <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">
          Permission mode
        </p>
        <div
          role="radiogroup"
          aria-label="Permission mode"
          aria-disabled={readOnlyReason ? true : undefined}
          className="space-y-0.5"
        >
          {offered.map(candidate => {
            const checked = candidate === chosen;
            const unavailable = !!readOnlyReason || !modes.includes(candidate);
            const descriptionId = `${radioId(candidate)}-description`;
            return (
              <button
                key={candidate}
                id={radioId(candidate)}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={modeLabel(provider, candidate)}
                aria-describedby={descriptionId}
                aria-disabled={unavailable ? true : undefined}
                tabIndex={checked ? 0 : -1}
                onKeyDown={onKeyDown}
                onClick={() => {
                  if (unavailable) return;
                  choose(candidate);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-100 outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  unavailable ? 'cursor-not-allowed' : 'hover:bg-accent',
                  checked && 'bg-accent',
                )}
              >
                <ModeIcon
                  mode={candidate}
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-sm font-medium">
                    {modeLabel(provider, candidate)}
                  </span>
                  <span
                    id={descriptionId}
                    className="block text-xs leading-5 text-muted-foreground"
                  >
                    {modeDescription(provider, candidate)}
                  </span>
                </span>
                <Check
                  className={cn(
                    'mt-0.5 size-3.5 shrink-0',
                    checked ? 'opacity-100' : 'opacity-0',
                  )}
                  aria-hidden="true"
                />
              </button>
            );
          })}
        </div>
        {readOnlyReason ? (
          <p
            role="note"
            className="px-2 pb-1 text-xs leading-5 text-muted-foreground"
          >
            {readOnlyReason}.
          </p>
        ) : (
          <p className="px-2 pb-1 text-xs leading-5 text-muted-foreground">
            Applies from the next turn. Shift+Tab cycles modes.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
