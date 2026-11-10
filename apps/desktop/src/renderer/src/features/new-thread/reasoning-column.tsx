import { Check } from 'lucide-react';
import { cn } from 'cn';
import type { ProviderState } from '@/entities/session';
import { effortLabel, modelEfforts } from './reasoning-effort';

type Props = {
  state: ProviderState;
  model: string;
  selected: string;
  onChoose: (effort: string) => void;
};

export function ReasoningColumn({ state, model, selected, onChoose }: Props) {
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
      className="flex w-36 shrink-0 flex-col border-l"
    >
      <div className="flex h-10 shrink-0 items-center border-b px-3 text-[11px] font-medium text-muted-foreground">
        Reasoning
      </div>
      {efforts ? (
        <div
          role="group"
          aria-label="Reasoning effort"
          className="flex flex-col gap-0.5 p-1.5"
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
                  'flex h-8 items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-100 outline-none',
                  'hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring',
                  isSelected && 'text-foreground',
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {effortLabel(option.id)}
                </span>
                {isDefault && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
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
