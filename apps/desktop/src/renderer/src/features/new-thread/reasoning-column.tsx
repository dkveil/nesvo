import { Check } from 'lucide-react';
import type { ProviderState } from '@/entities/session';
import { effortLabel } from '@/entities/session';
import { ListRow } from '@/shared/ui/list-row';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
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
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Reasoning
        </span>
        <span className="min-w-0 truncate text-2xs text-muted-foreground">
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
              <Hint key={option.id} label={option.description} side="right">
                <ListRow
                  selected={isSelected}
                  title={effortLabel(option.id)}
                  trailing={
                    <>
                      {isDefault && 'Default'}
                      {isSelected && (
                        <Check
                          aria-hidden="true"
                          className="size-3.5 text-foreground"
                        />
                      )}
                    </>
                  }
                  onClick={() => onChoose(option.id)}
                  mainProps={{
                    'aria-pressed': isSelected,
                    'aria-current': undefined,
                    ...{
                      'data-effort': option.id,
                      'data-default': isDefault || undefined,
                    },
                  }}
                />
              </Hint>
            );
          })}
        </div>
      ) : (
        <StatusMessage className="px-3 py-3">{notice}</StatusMessage>
      )}
    </div>
  );
}
