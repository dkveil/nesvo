import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  effortLabel,
  modelLabel,
  providers,
  ProviderGlyph,
  providerStatusLabel,
  type Provider,
  type ProviderStates,
} from '@/entities/session';
import { IconButton } from '@/shared/ui/icon-button';
import { Listbox } from '@/shared/ui/listbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover';
import { SegmentedControl } from '@/shared/ui/segmented-control';
import { StatusDot } from '@/shared/ui/status-dot';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { ComposerChip } from './composer-chip';
import { ReasoningColumn } from './reasoning-column';

type Props = {
  provider: Provider;
  model: string;
  effort: string;
  statuses: ProviderStates;
  disabled?: boolean;
  lockedProvider?: boolean;
  claudeEffort?: boolean;
  triggerLabel?: string;
  displayLabel?: string;
  hint?: string;
  triggerClassName?: string;
  onChange: (provider: Provider, model: string, effort: string) => void;
  onRefreshProvider: (provider: Provider) => void;
};

export function ModelPicker({
  provider,
  model,
  effort,
  statuses,
  disabled = false,
  lockedProvider = false,
  claudeEffort = false,
  triggerLabel = 'Choose model',
  displayLabel,
  hint,
  triggerClassName,
  onChange,
  onRefreshProvider,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const state = statuses[provider];
  const models = state.status?.models ?? [];
  const labelOf = (id: string) =>
    models.find(option => option.id === id)?.label ?? modelLabel(id);
  const shownLabel = displayLabel ?? (model ? labelOf(model) : 'No model');
  const chipLabel = effort
    ? `${shownLabel} · ${effortLabel(effort)}`
    : shownLabel;
  const previewModel = activeId ?? model;
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
    setActiveId(null);
  };
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) setActiveId(null);
      }}
    >
      <Hint label={`${provider} · ${chipLabel}${hint ? ` · ${hint}` : ''}`}>
        <PopoverTrigger asChild>
          <ComposerChip
            disabled={disabled}
            aria-label={triggerLabel}
            icon={<ProviderGlyph provider={provider} />}
            className={cn('text-ui text-foreground', triggerClassName)}
          >
            <span className="font-semibold">{shownLabel}</span>
            {effort && (
              <span className="shrink-0 text-muted-foreground">
                {effortLabel(effort)}
              </span>
            )}
            {hint && (
              <span className="shrink-0 text-muted-foreground">· {hint}</span>
            )}
          </ComposerChip>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        side="top"
        align="end"
        collisionPadding={12}
        aria-label="Model"
        surface="solid"
        size="lg"
        padding="none"
        className="flex max-h-[min(22rem,var(--radix-popover-content-available-height))] overflow-hidden"
      >
        {!lockedProvider && (
          <div className="shrink-0 border-r p-1">
            <SegmentedControl
              label="Provider"
              size="md"
              iconOnly
              orientation="vertical"
              value={provider}
              onChange={selectProvider}
              options={providers.map(item => ({
                value: item,
                label: item,
                title: providerStatusLabel(item, statuses[item]),
                icon: (
                  <span className="relative flex">
                    <ProviderGlyph provider={item} className="text-current" />
                    <StatusDot
                      tone={
                        statuses[item].status?.status === 'ready'
                          ? 'success'
                          : 'neutral'
                      }
                      className="absolute -top-1 -right-1"
                    />
                  </span>
                ),
              }))}
            />
          </div>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Listbox
            key={provider}
            label="Models"
            searchable
            autoFocus
            searchPlaceholder="Search models…"
            emptyText={
              models.length === 0
                ? 'No models reported yet.'
                : 'No matching models.'
            }
            options={models.map(option => ({
              value: option.id,
              label: option.label,
              keywords: option.id,
              icon: <ProviderGlyph provider={provider} />,
            }))}
            value={model}
            onActiveChange={setActiveId}
            onSelect={choose}
            className="min-h-0 flex-1"
          />
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-t pr-1.5 pl-3">
            <StatusMessage
              tone={state.error ? 'error' : 'info'}
              icon={false}
              className="min-w-0 truncate"
            >
              {state.error || providerStatusLabel(provider, state)}
            </StatusMessage>
            <IconButton
              label={`Refresh ${provider} status`}
              size={24}
              disabled={state.loading}
              onClick={() => onRefreshProvider(provider)}
            >
              <RefreshCw
                className={cn(
                  state.loading && 'animate-spin motion-reduce:animate-none',
                )}
              />
            </IconButton>
          </div>
        </div>
        <ReasoningColumn
          provider={provider}
          claudeEffort={claudeEffort}
          state={state}
          model={previewModel}
          modelLabel={labelOf(previewModel)}
          selected={previewModel === model ? effort : ''}
          onChoose={chooseEffort}
        />
      </PopoverContent>
    </Popover>
  );
}
