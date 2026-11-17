const SMALLEST_SHOWN_USD = 0.01;

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatSpend(cost: number | null): string {
  if (cost === null) return 'Unavailable';
  if (cost > 0 && cost < SMALLEST_SHOWN_USD) return '<$0.01';
  return usd.format(cost);
}
