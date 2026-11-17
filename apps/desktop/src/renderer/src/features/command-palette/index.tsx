import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { cn } from 'cn';
import type { Session } from '@/entities/session';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/shared/ui/dialog';
import {
  filterPaletteItems,
  maxVisibleItems,
  type PaletteActions,
} from './palette-items';

export type { PaletteActions } from './palette-items';

type Props = {
  open: boolean;
  sessions: Session[];
  actions: PaletteActions;
  onOpenChange: (open: boolean) => void;
};

type ContentProps = {
  sessions: Session[];
  actions: PaletteActions;
  onClose: () => void;
};

const PaletteContent = ({ sessions, actions, onClose }: ContentProps) => {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const ranAction = useRef(false);
  const items = filterPaletteItems(sessions, actions, query);
  const active = Math.min(activeIndex, Math.max(items.length - 1, 0));
  const optionId = (id: string) => `${listId}-${id}`;
  const activeItem = items[active];
  const run = (index: number) => {
    const item = items[index];
    if (!item) return;
    ranAction.current = true;
    onClose();
    item.run();
  };
  const move = (step: number) => {
    if (!items.length) return;
    const next = (active + step + items.length) % items.length;
    setActiveIndex(next);
    const target = items[next];
    if (target)
      requestAnimationFrame(() =>
        document
          .getElementById(optionId(target.id))
          ?.scrollIntoView({ block: 'nearest' }),
      );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(active);
    }
  };
  return (
    <DialogContent
      showCloseButton={false}
      data-command-palette=""
      className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      onCloseAutoFocus={event => {
        if (ranAction.current) event.preventDefault();
      }}
    >
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <DialogDescription className="sr-only">
        Search sessions and commands, then press Enter to run the highlighted
        result.
      </DialogDescription>
      <div className="flex h-11 items-center gap-2 border-b px-3">
        <Search
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="text"
          role="combobox"
          aria-label="Search sessions and commands"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeItem && optionId(activeItem.id)}
          aria-autocomplete="list"
          placeholder="Search sessions and commands"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        style={{ maxHeight: `${maxVisibleItems * 2.25 + 0.5}rem` }}
        className="overflow-y-auto p-1"
      >
        {items.map((item, index) => (
          <div
            key={item.id}
            id={optionId(item.id)}
            role="option"
            aria-selected={index === active}
            aria-label={item.title}
            tabIndex={-1}
            onMouseDown={event => event.preventDefault()}
            onMouseMove={() => setActiveIndex(index)}
            onClick={() => run(index)}
            className={cn(
              'flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] transition-colors duration-100',
              index === active && 'bg-accent',
            )}
          >
            <span className="min-w-0 shrink truncate font-medium">
              {item.title}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.subtitle}
            </span>
            {item.shortcut && (
              <kbd className="shrink-0 rounded-sm border px-1 font-sans text-2xs leading-4 text-muted-foreground">
                {item.shortcut}
              </kbd>
            )}
            <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground/70">
              {item.kind}
            </span>
          </div>
        ))}
        {!items.length && (
          <p
            role="status"
            className="px-2.5 py-3 text-xs text-muted-foreground"
          >
            No matching sessions or commands
          </p>
        )}
      </div>
    </DialogContent>
  );
};

export const CommandPalette = ({
  open,
  sessions,
  actions,
  onOpenChange,
}: Props) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {open && (
      <PaletteContent
        sessions={sessions}
        actions={actions}
        onClose={() => onOpenChange(false)}
      />
    )}
  </Dialog>
);
