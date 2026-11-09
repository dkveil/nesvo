import { useState, type KeyboardEvent } from 'react';
import { Lock, Pencil } from 'lucide-react';
import type { CreateSessionInput } from '@nesvo/contracts';
import { cn } from 'cn';
import { modeLabels, type Provider } from '@/entities/session';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { ComposerChip } from './composer-chip';

type Mode = CreateSessionInput['mode'];

type Props = {
  provider: Provider;
  mode: Mode;
  disabled?: boolean;
  onChange: (mode: Mode) => void;
};

const CLAUDE_READ_ONLY_REASON = 'Claude runs read-only analysis in Nesvo';

const segments: { mode: Mode; icon: typeof Lock; description: string }[] = [
  {
    mode: 'read-only',
    icon: Lock,
    description: 'Read files and run read commands. No file writes.',
  },
  {
    mode: 'supervised',
    icon: Pencil,
    description:
      'Edit files in the working directory. Codex asks for approval when required.',
  },
];

export function PermissionPicker({
  provider,
  mode,
  disabled = false,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const unavailable = (candidate: Mode) =>
    candidate === 'supervised' && provider === 'Claude Code'
      ? CLAUDE_READ_ONLY_REASON
      : '';
  const current =
    segments.find(segment => segment.mode === mode) ?? segments[0]!;
  const Icon = current.icon;
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const available = segments.filter(segment => !unavailable(segment.mode));
    const index = available.findIndex(segment => segment.mode === mode);
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next =
      available[(index + offset + available.length) % available.length];
    if (next) {
      onChange(next.mode);
      document.getElementById(`thread-mode-${next.mode}`)?.focus();
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Permissions"
          title={`Permissions: ${modeLabels[mode]}`}
        >
          <Icon />
          <span>{modeLabels[mode]}</span>
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Permissions"
        className="w-72 space-y-3 p-3"
      >
        <p className="text-[11px] font-medium text-muted-foreground">
          Permissions
        </p>
        <div
          role="radiogroup"
          aria-label="Permission mode"
          className="grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-1"
        >
          {segments.map(segment => {
            const SegmentIcon = segment.icon;
            const reason = unavailable(segment.mode);
            const checked = segment.mode === mode;
            return (
              <button
                key={segment.mode}
                id={`thread-mode-${segment.mode}`}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={modeLabels[segment.mode]}
                aria-disabled={reason ? true : undefined}
                title={reason || modeLabels[segment.mode]}
                tabIndex={checked ? 0 : -1}
                onKeyDown={onKeyDown}
                onClick={() => {
                  if (!reason) onChange(segment.mode);
                }}
                className={cn(
                  'flex h-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 outline-none',
                  'focus-visible:ring-1 focus-visible:ring-ring',
                  reason
                    ? 'cursor-not-allowed opacity-40'
                    : 'hover:text-foreground',
                  checked && 'bg-accent text-foreground shadow-xs',
                )}
              >
                <SegmentIcon className="size-3.5" aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="space-y-1">
          <p className="text-[13px] font-medium">{modeLabels[current.mode]}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {current.description}
          </p>
          {provider === 'Claude Code' && (
            <p role="note" className="text-xs leading-5 text-muted-foreground">
              {CLAUDE_READ_ONLY_REASON}.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
