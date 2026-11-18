import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/cn';
import { Spinner } from '@/shared/ui/spinner';

type StatusDotTone =
  'neutral' | 'info' | 'success' | 'warning' | 'error' | 'accent' | 'strong';

type StatusDotVariant = 'solid' | 'hollow' | 'spinner';

type StatusDotProps = ComponentProps<'span'> & {
  tone?: StatusDotTone;
  variant?: StatusDotVariant;
  size?: 'sm' | 'md';
  pulse?: boolean;
  ringClassName?: string;
  label?: string;
};

const dotTones: Record<StatusDotTone, string> = {
  neutral: 'bg-muted-foreground',
  info: 'bg-info-foreground',
  success: 'bg-success-foreground',
  warning: 'bg-warning-foreground',
  error: 'bg-error-foreground',
  accent: 'bg-primary',
  strong: 'bg-foreground',
};

const hollowTones: Record<StatusDotTone, string> = {
  neutral: 'border-muted-foreground',
  info: 'border-info-foreground',
  success: 'border-success-foreground',
  warning: 'border-warning-foreground',
  error: 'border-error-foreground',
  accent: 'border-primary',
  strong: 'border-foreground',
};

const spinnerTones: Record<StatusDotTone, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-info-foreground',
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  accent: 'text-primary',
  strong: 'text-foreground',
};

export function StatusDot({
  tone = 'neutral',
  variant = 'solid',
  size = 'sm',
  pulse = false,
  ringClassName,
  label,
  className,
  ...props
}: StatusDotProps) {
  const spinner = variant === 'spinner';
  return (
    <span
      data-slot="status-dot"
      data-variant={variant}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-block shrink-0 rounded-full',
        size === 'sm' && 'size-1.5',
        size === 'md' && 'size-2',
        variant === 'solid' && dotTones[tone],
        variant === 'hollow' && ['border-[1.5px]', hollowTones[tone]],
        spinner && 'inline-flex items-center justify-center',
        pulse && 'animate-pulse',
        ringClassName && ['box-content border-2', ringClassName],
        className,
      )}
      {...props}
    >
      {spinner && (
        <Spinner
          className={cn(
            '-m-px stroke-3',
            size === 'sm' ? 'size-2' : 'size-2.5',
            spinnerTones[tone],
          )}
        />
      )}
    </span>
  );
}

export type { StatusDotTone, StatusDotVariant };
