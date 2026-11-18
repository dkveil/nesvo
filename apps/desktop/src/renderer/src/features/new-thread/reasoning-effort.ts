import type { ModelEfforts, ReasoningEffortOption } from '@nesvo/contracts';
import type { Provider, ProviderState } from '@/entities/session';

export function modelEfforts(
  state: ProviderState,
  model: string,
): ModelEfforts | null {
  const option = state.status?.models.find(item => item.id === model);
  return option && 'efforts' in option ? option.efforts : null;
}

export function claudeEfforts(state: ProviderState): ReasoningEffortOption[] {
  const status = state.status;
  return status && 'efforts' in status ? status.efforts : [];
}

export function resolveEffort(efforts: ModelEfforts | null, chosen: string) {
  if (!efforts) return '';
  return efforts.options.some(option => option.id === chosen)
    ? chosen
    : efforts.defaultEffort;
}

export function resolveProviderEffort(
  provider: Provider,
  state: ProviderState,
  model: string,
  chosen: string,
) {
  if (provider === 'Claude Code')
    return claudeEfforts(state).some(option => option.id === chosen)
      ? chosen
      : '';
  return resolveEffort(modelEfforts(state, model), chosen);
}
