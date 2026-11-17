import {
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { menuItem, menuLabel } from '@/shared/ui/menu-styles';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { SearchField } from '@/shared/ui/search-field';

type ListboxOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  group?: string;
  keywords?: string;
  disabled?: boolean;
};

type ListboxProps<T extends string> = {
  label: string;
  options: ListboxOption<T>[];
  value?: T | null;
  onSelect: (value: T) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  autoFocus?: boolean;
  className?: string;
};

const matches = <T extends string>(option: ListboxOption<T>, query: string) =>
  `${option.label} ${option.description ?? ''} ${option.keywords ?? ''}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());

export function Listbox<T extends string>({
  label,
  options,
  value = null,
  onSelect,
  searchable = false,
  searchPlaceholder = 'Search',
  emptyText = 'No matches',
  autoFocus = false,
  className,
}: ListboxProps<T>) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const visible = useMemo(
    () => options.filter(option => matches(option, query)),
    [options, query],
  );
  const enabled = visible.filter(option => !option.disabled);
  const initial =
    enabled.find(option => option.value === value)?.value ??
    enabled[0]?.value ??
    null;
  const [active, setActive] = useState<T | null>(initial);
  const current =
    active !== null && enabled.some(option => option.value === active)
      ? active
      : initial;
  const optionId = (option: T) => `${id}-option-${option}`;
  const reveal = (next: T) =>
    list.current
      ?.querySelector(`[id="${CSS.escape(optionId(next))}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const index = enabled.findIndex(option => option.value === current);
    const target =
      event.key === 'ArrowDown'
        ? Math.min(index + 1, enabled.length - 1)
        : event.key === 'ArrowUp'
          ? Math.max(index - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? enabled.length - 1
              : null;
    if (target !== null) {
      const next = enabled[target];
      if (!next) return;
      event.preventDefault();
      setActive(next.value);
      reveal(next.value);
      return;
    }
    if (event.key === 'Enter' && current !== null) {
      event.preventDefault();
      onSelect(current);
    }
  };
  const groups = [...new Set(visible.map(option => option.group ?? ''))];
  const activeDescendant = current === null ? undefined : optionId(current);
  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {searchable && (
        <SearchField
          variant="underline"
          aria-label={`Search ${label.toLocaleLowerCase()}`}
          aria-controls={`${id}-list`}
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          role="combobox"
          aria-expanded="true"
          placeholder={searchPlaceholder}
          autoFocus={autoFocus}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onClear={() => setQuery('')}
          onKeyDown={onKeyDown}
        />
      )}
      <div
        ref={list}
        id={`${id}-list`}
        role="listbox"
        aria-label={label}
        aria-activedescendant={searchable ? undefined : activeDescendant}
        tabIndex={searchable ? -1 : 0}
        autoFocus={!searchable && autoFocus}
        onKeyDown={searchable ? undefined : onKeyDown}
        className="focus-ring min-h-0 flex-1 overflow-y-auto rounded-control p-1"
      >
        {groups.map(group => (
          <div
            key={group || 'options'}
            role="group"
            aria-label={group || undefined}
          >
            {group && <div className={menuLabel}>{group}</div>}
            {visible
              .filter(option => (option.group ?? '') === group)
              .map(option => {
                const selected = option.value === value;
                return (
                  <div
                    key={option.value}
                    id={optionId(option.value)}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={option.disabled || undefined}
                    data-selected={selected ? '' : undefined}
                    data-highlighted={option.value === current ? '' : undefined}
                    data-disabled={option.disabled ? '' : undefined}
                    onPointerMove={() => {
                      if (!option.disabled) setActive(option.value);
                    }}
                    onClick={() => {
                      if (!option.disabled) onSelect(option.value);
                    }}
                    className={cn(
                      menuItem,
                      'cursor-pointer pr-7',
                      option.description &&
                        'h-auto min-h-11 items-start py-1.5',
                    )}
                  >
                    {option.icon}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.description && (
                        <span className="truncate text-2xs text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {option.trailing && (
                      <span className="shrink-0 text-2xs text-muted-foreground">
                        {option.trailing}
                      </span>
                    )}
                    {selected && (
                      <Check
                        aria-hidden="true"
                        className="absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-foreground"
                      />
                    )}
                  </div>
                );
              })}
          </div>
        ))}
        {visible.length === 0 && (
          <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
            {emptyText}
          </p>
        )}
      </div>
    </div>
  );
}

type ComboboxProps<T extends string> = Omit<
  ListboxProps<T>,
  'autoFocus' | 'onSelect'
> & {
  trigger: ReactNode;
  onSelect: (value: T) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  size?: 'sm' | 'md' | 'lg' | 'trigger';
};

export function Combobox<T extends string>({
  trigger,
  onSelect,
  open,
  onOpenChange,
  align = 'start',
  side,
  size = 'sm',
  searchable = true,
  ...listbox
}: ComboboxProps<T>) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = typeof open === 'boolean';
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        size={size}
        surface="solid"
        padding="none"
        className="flex max-h-[min(22rem,var(--radix-popover-content-available-height))] flex-col overflow-hidden"
      >
        <Listbox
          {...listbox}
          searchable={searchable}
          autoFocus
          onSelect={value => {
            onSelect(value);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export type { ListboxOption };
