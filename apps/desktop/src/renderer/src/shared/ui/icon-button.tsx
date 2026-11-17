import type { ComponentProps } from 'react';
import { cn } from 'cn';
import { Hint } from '@/shared/ui/tooltip';

type IconButtonSize = 16 | 20 | 24 | 28 | 32;

type IconButtonProps = Omit<ComponentProps<'button'>, 'aria-label'> & {
  label: string;
  size?: IconButtonSize;
  tone?: 'default' | 'sidebar' | 'danger';
  shape?: 'square' | 'round';
  appearance?: 'ghost' | 'send';
  pressed?: boolean;
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
};

export function IconButton({
  label,
  size = 28,
  tone = 'default',
  shape = 'square',
  appearance = 'ghost',
  pressed,
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
      data-selected={pressed ? '' : undefined}
      className={cn(
        'focus-ring press inline-flex shrink-0 items-center justify-center transition-[color,background-color,scale] duration-fast ease-out disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
        sizeClasses[size],
        shape === 'round' && 'rounded-full',
        appearance === 'ghost' && [
          tone === 'default' &&
            'text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground data-selected:bg-highlight data-selected:text-foreground',
          tone === 'sidebar' &&
            'text-sidebar-icon enabled:hover:bg-sidebar-row-hover enabled:hover:text-sidebar-foreground aria-expanded:bg-sidebar-row-hover aria-expanded:text-sidebar-foreground data-selected:bg-sidebar-row-selected data-selected:text-sidebar-foreground',
          tone === 'danger' &&
            'text-muted-foreground enabled:hover:bg-accent enabled:hover:text-error-foreground aria-expanded:bg-accent',
        ],
        appearance === 'send' &&
          "rounded-full bg-primary text-primary-foreground enabled:hover:bg-primary/90 disabled:bg-send-idle disabled:text-send-idle-foreground disabled:opacity-100 [&_svg:not([class*='size-'])]:size-4",
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
