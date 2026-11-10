import { Check } from 'lucide-react';
import { cn } from 'cn';
import type { ProviderState } from '@/entities/session';
import { effortLabel } from '@/entities/session';
import { modelEfforts } from './reasoning-effort';

type Props = {
  state: ProviderState;
  model: string;
  modelLabel: string;
  selected: string;
  onChoose: (effort: string) => void;
};

export function ReasoningColumn({
  state,
  model,
  modelLabel,
  selected,
  onChoose,
}: Props) {
  const support = state.status?.effort;
  const efforts =
    support?.status === 'per-model' ? modelEfforts(state, model) : null;
  const notice =
    support?.status === 'unsupported'
      ? support.reason
      : support
        ? 'This model reports no reasoning options.'
        : 'Reasoning options appear after the provider is checked.';
  return (
    <div
      role="group"
      aria-label="Reasoning"
      data-effort-support={support?.status ?? 'unknown'}
      className="flex w-40 shrink-0 flex-col border-l"
    >
      <div className="mx-2 mt-1.5 flex h-8 shrink-0 items-center justify-between gap-2 border-b px-1 text-xs">
        <span className="font-medium text-muted-foreground">Reasoning</span>
        <span className="min-w-0 truncate text-2xs text-secondary-label">
          {modelLabel}
        </span>
      </div>
      {efforts ? (
        <div
          role="group"
          aria-label="Reasoning effort"
          className="flex flex-col p-1"
        >
          {efforts.options.map(option => {
            const isDefault = option.id === efforts.defaultEffort;
            const isSelected = option.id === selected;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={isSelected}
                data-effort={option.id}
                data-default={isDefault || undefined}
                title={option.description || undefined}
                onClick={() => onChoose(option.id)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-sm px-2 text-left text-[13px] font-medium text-foreground/85 transition-colors duration-100 outline-none',
                  'hover:bg-highlight hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                  isSelected && 'text-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {effortLabel(option.id)}
                </span>
                {isDefault && (
                  <span className="shrink-0 text-2xs font-normal text-secondary-label">
                    Default
                  </span>
                )}
                {isSelected && (
                  <Check className="size-3.5 shrink-0" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="px-3 py-3 text-[11px] leading-5 text-muted-foreground">
          {notice}
        </p>
      )}
    </div>
  );
}
