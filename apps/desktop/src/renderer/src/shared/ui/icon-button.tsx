import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/cn';
import { Hint } from '@/shared/ui/tooltip';

type IconButtonSize = 16 | 20 | 24 | 28 | 32 | 40;

type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label'> & {
  label: string;
  size?: IconButtonSize;
  tone?: 'default' | 'sidebar' | 'danger';
  shape?: 'square' | 'round';
  appearance?: 'ghost' | 'send';
  pressed?: boolean;
  current?: boolean;
  marker?: boolean;
  shortcut?: string;
  tooltip?: boolean;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
};

const sizeClasses: Record<IconButtonSize, string> = {
  16: "size-4 rounded-sm [&_svg:not([class*='size-'])]:size-3",
  20: "size-5 rounded-sm [&_svg:not([class*='size-'])]:size-3",
  24: "size-6 rounded-control [&_svg:not([class*='size-'])]:size-3.5",
  28: "size-7 rounded-control [&_svg:not([class*='size-'])]:size-4",
  32: "size-8 rounded-control [&_svg:not([class*='size-'])]:size-4",
  40: "size-10 rounded-surface [&_svg:not([class*='size-'])]:size-4.5",
};

export function IconButton({
  label,
  size = 28,
  tone = 'default',
  shape = 'square',
  appearance = 'ghost',
  pressed,
  current = false,
  marker = false,
  shortcut,
  tooltip = true,
  tooltipSide,
  type = 'button',
  className,
  ...props
}: IconButtonProps) {
  const button = (
    <button
      type={type}
      data-slot="icon-button"
      aria-label={label}
      aria-pressed={pressed}
      aria-current={current ? 'page' : undefined}
      data-selected={pressed || current ? '' : undefined}
      className={cn(
        'focus-ring press inline-flex shrink-0 items-center justify-center transition-[color,background-color,scale] duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
        sizeClasses[size],
        shape === 'round' && 'rounded-full',
        marker &&
          'relative before:absolute before:top-1/2 before:-left-1.5 before:h-4 before:w-0.5 before:-translate-y-1/2 before:scale-y-0 before:rounded-full before:bg-foreground before:transition-transform before:duration-base before:ease-out data-selected:before:scale-y-100',
        appearance === 'ghost' && [
          tone === 'default' &&
            'text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground [&[aria-haspopup]]:aria-expanded:bg-accent [&[aria-haspopup]]:aria-expanded:text-foreground data-selected:bg-highlight data-selected:text-foreground',
          tone === 'sidebar' &&
            'text-sidebar-icon enabled:hover:bg-sidebar-row-hover enabled:hover:text-sidebar-foreground [&[aria-haspopup]]:aria-expanded:bg-sidebar-row-hover [&[aria-haspopup]]:aria-expanded:text-sidebar-foreground data-selected:bg-sidebar-row-selected data-selected:text-sidebar-foreground',
          tone === 'danger' &&
            'text-muted-foreground enabled:hover:bg-accent enabled:hover:text-error-foreground [&[aria-haspopup]]:aria-expanded:bg-accent',
        ],
        appearance === 'send' &&
          "rounded-full bg-primary text-primary-foreground [--focus-ring-color:var(--primary-foreground)] enabled:hover:bg-primary/90 disabled:bg-send-idle disabled:text-send-idle-foreground disabled:opacity-100 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
  return (
    <Hint
      label={label}
      shortcut={shortcut}
      side={tooltipSide}
      disabled={!tooltip}
    >
      {button}
    </Hint>
  );
}
