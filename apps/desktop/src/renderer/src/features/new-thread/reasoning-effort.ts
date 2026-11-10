import type { ModelEfforts } from '@nesvo/contracts';
import type { ProviderState } from '@/entities/session';

const effortLabels: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export function effortLabel(effort: string) {
  return (
    effortLabels[effort] ??
    `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`
  );
}

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
