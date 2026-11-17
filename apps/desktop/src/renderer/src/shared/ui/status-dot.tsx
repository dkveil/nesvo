import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/cn';

type StatusDotTone =
  'neutral' | 'info' | 'success' | 'warning' | 'error' | 'accent' | 'strong';

type StatusDotProps = ComponentProps<'span'> & {
  tone?: StatusDotTone;
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

export function StatusDot({
  tone = 'neutral',
  size = 'sm',
  pulse = false,
  ringClassName,
  label,
  className,
  ...props
}: StatusDotProps) {
  return (
    <span
      data-slot="status-dot"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(
        'inline-block shrink-0 rounded-full',
        size === 'sm' && 'size-1.5',
        size === 'md' && 'size-2',
        dotTones[tone],
        pulse && 'animate-pulse',
        ringClassName && ['box-content border-2', ringClassName],
        className,
      )}
      {...props}
    />
  );
}

export type { StatusDotTone };
