const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 6,
});

export function formatCost(cost: number | null): string {
  if (cost === null) return 'Unavailable';
  if (cost > 0 && cost < 0.000001) return '<$0.000001';
  return usd.format(cost);
}
