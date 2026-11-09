import { useRef, useState, type KeyboardEvent } from 'react';
import { Check, RefreshCw, Search } from 'lucide-react';
import { cn } from 'cn';
import {
  modelLabel,
  providers,
  providerStatusLabel,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { ComposerChip } from './composer-chip';
import { providerMarks } from './provider-mark';

type Props = {
  provider: Provider;
  model: string;
  statuses: ProviderStates;
  disabled?: boolean;
  onChange: (provider: Provider, model: string) => void;
  onRefreshProvider: (provider: Provider) => void;
};

export function ModelPicker({
  provider,
  model,
  statuses,
  disabled = false,
  onChange,
  onRefreshProvider,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const state = statuses[provider];
  const models = state.status?.models ?? [];
  const visible = models.filter(option =>
    `${option.label} ${option.id}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const active =
    visible.find(option => option.id === activeId) ??
    visible.find(option => option.id === model) ??
    visible[0];
  const currentLabel = model
    ? (models.find(option => option.id === model)?.label ?? modelLabel(model))
    : 'No model';
  const listId = 'thread-model-options';
  const optionId = (id: string) => `${listId}-${id.replace(/[^\w-]/g, '_')}`;
  const choose = (id: string) => {
    onChange(provider, id);
    setOpen(false);
  };
  const selectProvider = (next: Provider) => {
    const nextModels = statuses[next].status?.models ?? [];
    onChange(next, nextModels[0]?.id ?? '');
    setQuery('');
    setActiveId('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!visible.length) return;
      const index = visible.findIndex(option => option.id === active?.id);
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const next = visible[(index + offset + visible.length) % visible.length];
      if (next) {
        setActiveId(next.id);
        document
          .getElementById(optionId(next.id))
          ?.scrollIntoView({ block: 'nearest' });
      }
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      choose(active.id);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) {
          setQuery('');
          setActiveId('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <ComposerChip
          disabled={disabled}
          aria-label="Choose model"
          title={`${provider} · ${currentLabel}`}
          className="h-7 gap-1.5 text-xs text-foreground"
        >
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground">
            {providerMarks[provider]}
          </span>
          <span className="truncate font-medium">{currentLabel}</span>
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        aria-label="Model"
        className="flex w-[min(26rem,calc(100vw-1.5rem))] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={event => {
          event.preventDefault();
          search.current?.focus();
        }}
      >
        <div
          role="radiogroup"
          aria-label="Provider"
          className="flex flex-col gap-1 border-r p-2"
        >
          {providers.map(item => {
            const itemState = statuses[item];
            const ready = itemState.status?.status === 'ready';
            return (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={item === provider}
                aria-label={item}
                title={providerStatusLabel(item, itemState)}
                onClick={() => selectProvider(item)}
                className={cn(
                  'relative flex size-9 items-center justify-center rounded-md text-[11px] font-medium tracking-wide text-muted-foreground transition-colors duration-100 outline-none',
                  'hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                  item === provider && 'bg-accent text-foreground',
                )}
              >
                {providerMarks[item]}
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-1.5 right-1.5 size-1.5 rounded-full',
                    ready ? 'bg-success-foreground' : 'bg-muted-foreground/50',
                  )}
                />
              </button>
            );
          })}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-10 items-center gap-2 border-b px-3 text-muted-foreground">
            <Search className="size-3.5 shrink-0" aria-hidden="true" />
            <input
              ref={search}
              type="text"
              role="combobox"
              aria-label="Search models"
              aria-controls={listId}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={active ? optionId(active.id) : undefined}
              placeholder="Search models…"
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setActiveId('');
              }}
              onKeyDown={onKeyDown}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label="Models"
            className="max-h-64 overflow-y-auto p-1.5"
          >
            {visible.map(option => (
              <li
                key={option.id}
                id={optionId(option.id)}
                role="option"
                aria-selected={option.id === model}
                data-active={option.id === active?.id || undefined}
                onMouseEnter={() => setActiveId(option.id)}
                onClick={() => choose(option.id)}
                className={cn(
                  'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px]',
                  'data-active:bg-accent data-active:text-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.id === model && (
                  <Check className="size-3.5 shrink-0" aria-hidden="true" />
                )}
              </li>
            ))}
            {visible.length === 0 && (
              <li className="px-2 py-3 text-xs text-muted-foreground">
                {models.length === 0
                  ? 'No models reported yet.'
                  : 'No matching models.'}
              </li>
            )}
          </ul>
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span role="status" className="min-w-0 truncate">
              {state.error || providerStatusLabel(provider, state)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Refresh ${provider} status`}
              title={`Refresh ${provider} status`}
              disabled={state.loading}
              onClick={() => onRefreshProvider(provider)}
            >
              <RefreshCw
                className={cn(
                  'size-3',
                  state.loading && 'animate-spin motion-reduce:animate-none',
                )}
              />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
