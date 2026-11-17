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

export function unknownCost(count: number): string {
  return `${countFormat.format(count)} ${count === 1 ? 'turn' : 'turns'} without reported cost`;
}
