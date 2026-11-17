import type { ComponentProps } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from 'cn';

type SpinnerProps = ComponentProps<'svg'> & {
  size?: 'sm' | 'md';
  label?: string;
};

export function Spinner({
  size = 'sm',
  label,
  className,
  ...props
}: SpinnerProps) {
  return (
    <LoaderCircle
      data-slot="spinner"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'shrink-0 animate-spin text-muted-foreground',
        size === 'sm' && 'size-3.5',
        size === 'md' && 'size-4',
        className,
      )}
      {...props}
    />
  );
}
