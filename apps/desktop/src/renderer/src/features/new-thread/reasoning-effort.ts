import type { ModelEfforts } from '@nesvo/contracts';
import type { ProviderState } from '@/entities/session';

export function modelEfforts(
  state: ProviderState,
  model: string,
): ModelEfforts | null {
  const option = state.status?.models.find(item => item.id === model);
  return option && 'efforts' in option ? option.efforts : null;
}

export function resolveEffort(efforts: ModelEfforts | null, chosen: string) {
  if (!efforts) return '';
  return efforts.options.some(option => option.id === chosen)
    ? chosen
    : efforts.defaultEffort;
}
