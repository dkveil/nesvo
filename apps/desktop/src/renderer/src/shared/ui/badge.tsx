import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/cn';
import { Slot } from 'radix-ui';

type BadgeTone =
  'neutral' | 'info' | 'success' | 'warning' | 'error' | 'accent';

type BadgeProps = ComponentProps<'span'> & {
  tone?: BadgeTone;
  appearance?: 'soft' | 'outline';
  size?: 'xs' | 'sm';
  asChild?: boolean;
};

const softTones: Record<BadgeTone, string> = {
  neutral: 'bg-highlight text-secondary-foreground',
  info: 'bg-info-foreground/12 text-info-foreground',
  success: 'bg-success-foreground/12 text-success-foreground',
  warning: 'bg-warning-foreground/14 text-warning-foreground',
  error: 'bg-error-foreground/12 text-error-foreground',
  accent: 'bg-foreground text-background',
};

const outlineTones: Record<BadgeTone, string> = {
  neutral: 'border-border text-muted-foreground',
  info: 'border-info-foreground/40 text-info-foreground',
  success: 'border-success-foreground/40 text-success-foreground',
  warning: 'border-warning-foreground/40 text-warning-foreground',
  error: 'border-error-foreground/40 text-error-foreground',
  accent: 'border-foreground/50 text-foreground',
};

function Badge({
  tone = 'neutral',
  appearance = 'soft',
  size = 'sm',
  asChild = false,
  className,
  ...props
}: BadgeProps) {
  const Comp = asChild ? Slot.Root : 'span';
  return (
    <Comp
      data-slot="badge"
      data-tone={tone}
      className={cn(
        'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:shrink-0',
        size === 'xs' && 'h-4 px-1.5 text-micro [&>svg]:size-2.5',
        size === 'sm' && 'h-5 px-2 text-2xs [&>svg]:size-3',
        appearance === 'soft' ? softTones[tone] : outlineTones[tone],
        className,
      )}
      {...props}
    />
  );
}

type CountBadgeProps = Omit<ComponentProps<'span'>, 'children'> & {
  count: number;
  max?: number;
  tone?: 'strong' | 'muted';
};

function CountBadge({
  count,
  max = 99,
  tone = 'strong',
  className,
  ...props
}: CountBadgeProps) {
  return (
    <span
      data-slot="count-badge"
      className={cn(
        'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-2xs leading-none font-semibold tabular-nums',
        tone === 'strong' && 'bg-foreground text-background',
        tone === 'muted' && 'bg-highlight text-muted-foreground',
        className,
      )}
      {...props}
    >
      {count > max ? `${max}+` : count}
    </span>
  );
}

export { Badge, CountBadge, type BadgeTone };
