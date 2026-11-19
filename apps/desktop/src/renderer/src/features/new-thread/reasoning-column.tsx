import { Check } from 'lucide-react';
import type { ModelEfforts } from '@nesvo/contracts';
import type { Provider, ProviderState } from '@/entities/session';
import { effortLabel } from '@/entities/session';
import { ListRow } from '@/shared/ui/list-row';
import { StatusMessage } from '@/shared/ui/status-message';
import { Hint } from '@/shared/ui/tooltip';
import { claudeEfforts, modelEfforts } from './reasoning-effort';

type Props = {
  provider: Provider;
  claudeEffort: boolean;
  state: ProviderState;
  model: string;
  modelLabel: string;
  selected: string;
  onChoose: (effort: string) => void;
};

const claudeSessionOnly =
  'Claude Code effort can be chosen for sessions. This flow uses the CLI default.';

function columnEfforts(
  provider: Provider,
  state: ProviderState,
  model: string,
): ModelEfforts | null {
  if (provider !== 'Claude Code') return modelEfforts(state, model);
  const options = claudeEfforts(state);
  return options.length
    ? { options: [{ id: '', description: '' }, ...options], defaultEffort: '' }
    : null;
}

export function ReasoningColumn({
  provider,
  claudeEffort,
  state,
  model,
  modelLabel,
  selected,
  onChoose,
}: Props) {
  const support = state.status?.effort;
  const sessionOnly = provider === 'Claude Code' && !claudeEffort;
  const efforts =
    support?.status === 'per-model' && !sessionOnly
      ? columnEfforts(provider, state, model)
      : null;
  const notice = sessionOnly
    ? claudeSessionOnly
    : support?.status === 'unsupported'
      ? support.reason
      : support
        ? 'This model reports no reasoning options.'
        : 'Reasoning options appear after the provider is checked.';
  return (
    <div
      role="group"
      aria-label="Reasoning"
      data-effort-support={
        sessionOnly ? 'session-only' : (support?.status ?? 'unknown')
      }
      className="flex w-40 shrink-0 flex-col border-l"
    >
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Reasoning
        </span>
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
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
              <Hint
                key={option.id || 'default'}
                label={option.description || 'Use the CLI default effort'}
                side="right"
              >
                <ListRow
                  selected={isSelected}
                  className={isSelected ? 'font-medium' : undefined}
                  title={option.id ? effortLabel(option.id) : 'Default'}
                  trailing={
                    <>
                      {isDefault && option.id && 'Default'}
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
                      'data-effort': option.id || 'default',
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
