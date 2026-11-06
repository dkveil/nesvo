import type { ComponentProps } from 'react';

import { cn } from '../../libs/ui/cn';

export type StatusBadgeTone = 'neutral' | 'positive' | 'warning' | 'critical' | 'accent';
export type StatusBadgeProps = ComponentProps<'span'> & { tone?: StatusBadgeTone };

export const StatusBadge = ({ tone = 'neutral', className, ...props }: StatusBadgeProps) => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
      tone === 'neutral' && 'border-border text-muted',
      tone === 'positive' && 'border-success text-success',
      tone === 'warning' && 'border-warning text-warning',
      tone === 'critical' && 'border-danger text-danger',
      tone === 'accent' && 'border-accent text-accent',
      className,
    )}
    {...props}
  />
);
