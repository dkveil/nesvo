import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/cn';

type SkeletonProps = ComponentProps<'div'> & {
  shape?: 'line' | 'block' | 'circle';
};

export function Skeleton({
  shape = 'line',
  className,
  ...props
}: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        'shrink-0 animate-pulse bg-skeleton',
        shape === 'line' && 'h-2.5 rounded-sm',
        shape === 'block' && 'rounded-control',
        shape === 'circle' && 'rounded-full',
        className,
      )}
      {...props}
    />
  );
}

const TITLE_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/12', 'w-7/12'];
const DESCRIPTION_WIDTHS = ['w-1/3', 'w-2/5', 'w-1/4', 'w-1/2', 'w-1/3'];

type SkeletonListProps = Omit<ComponentProps<'div'>, 'children'> & {
  label: string;
  rows?: number;
  density?: 'compact' | 'two-line';
  leading?: boolean;
};

export function SkeletonList({
  label,
  rows = 5,
  density = 'compact',
  leading = true,
  className,
  ...props
}: SkeletonListProps) {
  return (
    <div
      data-slot="skeleton-list"
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn('flex w-full flex-col', className)}
      {...props}
    >
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(
            'flex items-center gap-2.5 px-2',
            density === 'compact' ? 'h-7' : 'h-11',
          )}
        >
          {leading && (
            <Skeleton
              shape={density === 'compact' ? 'circle' : 'block'}
              className={density === 'compact' ? 'size-3.5' : 'size-6'}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={TITLE_WIDTHS[index % TITLE_WIDTHS.length]} />
            {density === 'two-line' && (
              <Skeleton
                className={cn(
                  'h-2',
                  DESCRIPTION_WIDTHS[index % DESCRIPTION_WIDTHS.length],
                )}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
