import { formatCost } from '@/shared/lib/format-cost';
import { cn } from '@/shared/lib/cn';
import { Hint } from '@/shared/ui/tooltip';
import { formatSpend } from './format-spend';

export function CostAmount({
  cost,
  className,
}: {
  cost: number | null;
  className?: string;
}) {
  const shown = formatSpend(cost);
  const exact = formatCost(cost);
  const amount = <span className={cn('tabular-nums', className)}>{shown}</span>;
  return exact === shown || cost === null ? (
    amount
  ) : (
    <Hint label={`Exactly ${exact}`}>{amount}</Hint>
  );
}
