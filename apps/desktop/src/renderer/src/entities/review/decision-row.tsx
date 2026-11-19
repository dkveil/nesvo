import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';
import { ListRow } from '@/shared/ui/list-row';

type Props = {
  heading: ReactNode;
  details: ReactNode;
  children?: ReactNode;
  alignActions?: 'heading' | 'summary';
};

export function DecisionRow({
  heading,
  details,
  children,
  alignActions = 'heading',
}: Props) {
  const centerOnSummary = alignActions === 'summary';
  return (
    <ListRow
      density="block"
      columns="minmax(0, 1fr) auto"
      className={cn(
        '[&>div]:gap-x-4 [&>div]:gap-y-1 [&>div]:py-2 [&_[data-inbox-actions]]:col-start-2 [&_[data-inbox-actions]]:row-start-1 [&_[data-inbox-actions]]:flex [&_[data-inbox-actions]]:min-h-7 [&_[data-inbox-actions]]:items-center [&_[data-inbox-actions]]:justify-end [&_[data-inbox-actions]]:gap-2',
        centerOnSummary
          ? '[&_[data-inbox-actions]]:row-end-3 [&_[data-inbox-actions]]:self-center'
          : '[&_[data-inbox-actions]]:self-start',
      )}
    >
      <div
        data-inbox-heading
        className={cn(
          'col-start-1 row-start-1 min-w-0 text-ui',
          !centerOnSummary &&
            'flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1',
        )}
      >
        {heading}
      </div>
      <div className="col-start-1 row-start-2 min-w-0 space-y-1">{details}</div>
      {children}
    </ListRow>
  );
}
