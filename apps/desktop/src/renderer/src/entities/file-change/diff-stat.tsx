import type { ComponentProps } from 'react';
import { cn } from 'cn';

type DiffStatProps = Omit<ComponentProps<'span'>, 'children'> & {
  additions: number;
  deletions: number;
  size?: 'xs' | 'sm';
};

export function DiffStat({
  additions,
  deletions,
  size = 'xs',
  className,
  ...props
}: DiffStatProps) {
  return (
    <span
      data-slot="diff-stat"
      className={cn(
        'inline-flex shrink-0 gap-1.5 font-mono tabular-nums',
        size === 'xs' ? 'text-2xs' : 'text-xs',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="text-success-foreground">
        +{additions}
      </span>
      <span aria-hidden="true" className="text-error-foreground">
        −{deletions}
      </span>
      <span className="sr-only">
        {additions} added, {deletions} removed
      </span>
    </span>
  );
}
