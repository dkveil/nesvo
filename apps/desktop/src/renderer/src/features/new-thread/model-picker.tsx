import { useRef, useState, type KeyboardEvent } from 'react';
import { Check, RefreshCw, Search } from 'lucide-react';
import { cn } from 'cn';
import {
  effortLabel,
  modelLabel,
  providerSlugs,
  providers,
  ProviderGlyph,
  providerStatusLabel,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { Button } from '@/shared/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { ComposerChip } from './composer-chip';
import { ReasoningColumn } from './reasoning-column';

type Props = {
  provider: Provider;
  model: string;
  effort: string;
  statuses: ProviderStates;
  disabled?: boolean;
  onChange: (provider: Provider, model: string, effort: string) => void;
  onRefreshProvider: (provider: Provider) => void;
};

export function ModelPicker({
  provider,
  model,
  effort,
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
  const chipLabel = effort
    ? `${currentLabel} · ${effortLabel(effort)}`
    : currentLabel;
  const previewModel = active?.id ?? model;
  const previewLabel =
    models.find(option => option.id === previewModel)?.label ??
    modelLabel(previewModel);
  const listId = 'thread-model-options';
  const optionId = (id: string) => `${listId}-${id.replace(/[^\w-]/g, '_')}`;
  const choose = (id: string) => {
    onChange(provider, id, effort);
    setOpen(false);
  };
  const chooseEffort = (next: string) => {
    onChange(provider, previewModel, next);
    setOpen(false);
  };
  const selectProvider = (next: Provider) => {
    const nextModels = statuses[next].status?.models ?? [];
    onChange(next, nextModels[0]?.id ?? '', '');
    setQuery('');
    setActiveId('');
  };
  const onProviderKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = providers.indexOf(provider);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const next =
      providers[(index + offset + providers.length) % providers.length];
    if (next) {
      selectProvider(next);
      document
        .getElementById(`thread-provider-${providerSlugs[next]}`)
        ?.focus();
    }
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
          title={`${provider} · ${chipLabel}`}
          className="h-7 gap-1.5 text-[13px] text-foreground"
        >
          <ProviderGlyph provider={provider} />
          <span className="truncate font-semibold">{currentLabel}</span>
          {effort && (
            <span className="shrink-0 text-muted-foreground">
              {effortLabel(effort)}
            </span>
          )}
        </ComposerChip>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={10}
        collisionPadding={12}
        aria-label="Model"
        className="flex w-[min(30rem,calc(100vw-1.5rem))] gap-0 overflow-hidden p-0"
        onOpenAutoFocus={event => {
          event.preventDefault();
          search.current?.focus();
        }}
      >
        <div
          role="radiogroup"
          aria-label="Provider"
          className="flex w-10 shrink-0 flex-col items-center gap-1 border-r py-1.5"
        >
          {providers.map(item => {
            const itemState = statuses[item];
            const ready = itemState.status?.status === 'ready';
            return (
              <button
                key={item}
                id={`thread-provider-${providerSlugs[item]}`}
                type="button"
                role="radio"
                aria-checked={item === provider}
                aria-label={item}
                tabIndex={item === provider ? 0 : -1}
                title={providerStatusLabel(item, itemState)}
                onKeyDown={onProviderKeyDown}
                onClick={() => selectProvider(item)}
                className={cn(
                  'relative flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 outline-none',
                  'hover:bg-highlight hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  'after:absolute after:top-1.5 after:-right-1.5 after:h-4 after:w-0.5 after:rounded-full after:bg-transparent',
                  item === provider && 'text-foreground after:bg-primary',
                )}
              >
                <ProviderGlyph
                  provider={item}
                  className="size-4 text-current"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-0.5 right-0.5 size-1.5 rounded-full',
                    ready ? 'bg-success-foreground' : 'bg-muted-foreground/50',
                  )}
                />
              </button>
            );
          })}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="mx-2 mt-1.5 flex h-8 items-center gap-2 border-b px-1 text-muted-foreground transition-colors duration-150 focus-within:border-ring">
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
            className="max-h-64 overflow-y-auto p-1"
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
                  'flex h-7 cursor-pointer items-center gap-2 rounded-sm px-2 text-[13px] font-medium',
                  'data-active:bg-highlight data-active:text-foreground',
                )}
              >
                <ProviderGlyph provider={provider} />
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
          <div className="flex h-9 items-center justify-between gap-2 border-t px-3 text-[11px] text-muted-foreground">
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
        <ReasoningColumn
          state={state}
          model={previewModel}
          modelLabel={previewLabel}
          selected={previewModel === model ? effort : ''}
          onChoose={chooseEffort}
        />
      </PopoverContent>
    </Popover>
  );
}
