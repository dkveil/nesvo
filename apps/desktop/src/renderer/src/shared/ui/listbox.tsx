import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { listboxOptionId } from '@/shared/ui/listbox-option-id';
import { menuItem, menuLabel } from '@/shared/ui/menu-styles';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { SearchField } from '@/shared/ui/search-field';

type ListboxOption<T extends string> = {
  value: T;
  label: string;
  description?: ReactNode;
  wrapDescription?: boolean;
  icon?: ReactNode;
  trailing?: ReactNode;
  group?: string;
  keywords?: string;
  disabled?: boolean;
  ariaLabel?: string;
  attributes?: Record<`data-${string}`, string>;
};

type ListboxProps<T extends string> = {
  label: string;
  options: ListboxOption<T>[];
  value?: T | null;
  onSelect: (value: T) => void;
  searchable?: boolean;
  searchLabel?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  autoFocus?: boolean;
  query?: string;
  onQueryChange?: (query: string) => void;
  id?: string;
  active?: T | null;
  onActiveChange?: (value: T | null) => void;
  className?: string;
};

const matches = <T extends string>(option: ListboxOption<T>, query: string) =>
  `${option.label} ${typeof option.description === 'string' ? option.description : ''} ${option.keywords ?? ''}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());

export function Listbox<T extends string>({
  label,
  options,
  value = null,
  onSelect,
  searchable = false,
  searchLabel,
  searchPlaceholder = 'Search',
  emptyText = 'No matches',
  autoFocus = false,
  query: controlledQuery,
  onQueryChange,
  id: listIdProp,
  active,
  onActiveChange,
  className,
}: ListboxProps<T>) {
  const generatedId = useId();
  const listId = listIdProp ?? `${generatedId}-list`;
  const list = useRef<HTMLDivElement>(null);
  const notifyActive = useRef(onActiveChange);
  const [internalQuery, setInternalQuery] = useState('');
  const isControlled = typeof controlledQuery === 'string';
  const query = isControlled ? controlledQuery : internalQuery;
  const setQuery = (next: string) => {
    if (!isControlled) setInternalQuery(next);
    onQueryChange?.(next);
  };
  const visible = useMemo(
    () => options.filter(option => matches(option, query)),
    [options, query],
  );
  const enabled = visible.filter(option => !option.disabled);
  const initial =
    enabled.find(option => option.value === value)?.value ??
    enabled[0]?.value ??
    null;
  const [highlighted, setHighlighted] = useState<T | null>(initial);
  const preferred = active ?? highlighted;
  const current =
    preferred !== null && enabled.some(option => option.value === preferred)
      ? preferred
      : initial;
  const optionId = (option: T) => listboxOptionId(listId, option);
  const highlight = (next: T) => {
    setHighlighted(next);
    if (active != null) onActiveChange?.(next);
  };
  useEffect(() => {
    notifyActive.current = onActiveChange;
  }, [onActiveChange]);
  useEffect(() => {
    notifyActive.current?.(current);
    if (current === null) return;
    list.current
      ?.querySelector(`[id="${CSS.escape(listboxOptionId(listId, current))}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);
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
      highlight(next.value);
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
          aria-label={searchLabel ?? `Search ${label.toLocaleLowerCase()}`}
          aria-controls={listId}
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
        id={listId}
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
                    aria-label={option.ariaLabel}
                    aria-selected={selected}
                    aria-disabled={option.disabled || undefined}
                    data-selected={selected ? '' : undefined}
                    data-highlighted={option.value === current ? '' : undefined}
                    data-disabled={option.disabled ? '' : undefined}
                    onPointerMove={() => {
                      if (!option.disabled && option.value !== current)
                        highlight(option.value);
                    }}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => {
                      if (!option.disabled) onSelect(option.value);
                    }}
                    className={cn(
                      menuItem,
                      'cursor-pointer pr-7',
                      option.description &&
                        'h-auto min-h-11 items-start py-1.5',
                    )}
                    {...option.attributes}
                  >
                    {option.icon}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.description && (
                        <span
                          className={cn(
                            'text-2xs text-muted-foreground',
                            option.wrapDescription
                              ? 'line-clamp-2 whitespace-normal break-words'
                              : 'truncate',
                          )}
                        >
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
