import type { CostTotals } from '@nesvo/contracts';
export const periodLabels = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
} as const;
export const scopeLabels = {
  computer: 'Computer',
  directory: 'Directory',
  session: 'Session',
} as const;
export const actionLabels = {
  warn: 'Warn',
  'refuse-new-turns': 'Refuse new turns',
} as const;

export const countFormat = new Intl.NumberFormat('en');

export function costCoverage(totals: CostTotals): string {
  if (!totals.turnCount) return '';
  const unpriced = totals.unknownCostTurns
    ? `${countFormat.format(totals.unknownCostTurns)} unpriced`
    : '';
  const source = totals.estimatedCostTurns
    ? 'Estimated'
    : totals.costUsd === null
      ? ''
      : 'Provider-reported';
  return [source, unpriced].filter(Boolean).join(' · ');
}
