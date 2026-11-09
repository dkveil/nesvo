import { useState, type KeyboardEvent } from 'react';
import { Check, Monitor, Plus } from 'lucide-react';
import type { Computer } from '@nesvo/contracts';
import { cn } from 'cn';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { ComposerChip } from './composer-chip';

type Props = {
  computers: Computer[];
  hostId: string;
  disabled?: boolean;
  onChange: (hostId: string) => void;
  onManageComputers: () => void;
};

const statusLabels: Record<Computer['status'], string> = {
  connected: '',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  disconnected: 'Offline',
  error: 'Connection failed',
};

export function HostPicker({
  computers,
  hostId,
  disabled = false,
  onChange,
  onManageComputers,
}: Props) {
  const [open, setOpen] = useState(false);
  const computer = computers.find(item => item.id === hostId);
  const connected = computer?.status === 'connected';
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = computers.findIndex(item => item.id === hostId);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const next =
      computers[(index + offset + computers.length) % computers.length];
    if (next) {
      onChange(next.id);
      document.getElementById(`thread-host-${next.id}`)?.focus();
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Run on"
          title={`Run on ${computer?.name ?? 'Local'}`}
        >
          <Monitor />
          <span className="truncate">{computer?.name ?? 'Local'}</span>
          {!connected && (
            <span>
              · {statusLabels[computer?.status ?? 'disconnected'] || 'Offline'}
            </span>
          )}
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        aria-label="Run on"
        className="w-64 p-1.5"
      >
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
          Run on
        </p>
        <div role="radiogroup" aria-label="Computer" className="space-y-px">
          {computers.map(item => (
            <button
              key={item.id}
              id={`thread-host-${item.id}`}
              type="button"
              role="radio"
              aria-checked={item.id === hostId}
              tabIndex={item.id === hostId ? 0 : -1}
              onKeyDown={onKeyDown}
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
              className={cn(
                'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-100 outline-none',
                'hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring',
                item.id === hostId && 'bg-accent',
              )}
            >
              <Monitor
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {statusLabels[item.status] && (
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {statusLabels[item.status]}
                </span>
              )}
              {item.id === hostId && (
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onManageComputers();
          }}
          className="mt-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors duration-100 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Plus className="size-3.5 shrink-0" aria-hidden="true" />
          Add to another machine
        </button>
      </PopoverContent>
    </Popover>
  );
}
