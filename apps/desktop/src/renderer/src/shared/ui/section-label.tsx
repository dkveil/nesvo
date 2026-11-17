import type { ComponentProps, ReactNode } from 'react';
import { cn } from 'cn';

type SectionLabelProps = ComponentProps<'div'> & {
  as?: 'h2' | 'h3' | 'h4' | 'p';
  action?: ReactNode;
  count?: number;
};

export function SectionLabel({
  as: Heading = 'h3',
  action,
  count,
  className,
  children,
  ...props
}: SectionLabelProps) {
  return (
    <div
      data-slot="section-label"
      className={cn(
        'flex h-6 min-w-0 items-center justify-between gap-2 px-2',
        className,
      )}
      {...props}
    >
      <Heading className="flex min-w-0 items-center gap-1.5 truncate text-2xs font-medium text-muted-foreground">
        {children}
        {count != null && (
          <span className="text-micro text-muted-foreground/80 tabular-nums">
            {count}
          </span>
        )}
      </Heading>
      {action && (
        <div className="flex shrink-0 items-center gap-0.5">{action}</div>
      )}
    </div>
  );
}
