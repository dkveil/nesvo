import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

type ChipProps = ComponentProps<'button'> & {
  size?: 'inline' | 'sm' | 'md';
  icon?: ReactNode;
  selected?: boolean;
  interactive?: boolean;
};

const chipClasses = (size: ChipProps['size']) =>
  cn(
    'inline-flex max-w-56 min-w-0 shrink-0 items-center rounded-control text-xs text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5 [&>span]:min-w-0 [&>span]:truncate',
    size === 'inline' &&
      'h-5 gap-1 bg-accent px-1.5 align-middle leading-none text-foreground [&_svg:not([class*=size-])]:size-3',
    size === 'sm' && 'h-6 gap-1 px-1.5',
    size === 'md' && 'h-7 gap-1.5 px-2',
  );

export function Chip({
  size = 'md',
  icon,
  selected,
  interactive = true,
  type = 'button',
  className,
  children,
  ...props
}: ChipProps) {
  if (!interactive)
    return (
      <span
        data-slot="chip"
        className={cn(chipClasses(size), className)}
        {...(props as ComponentProps<'span'>)}
      >
        {icon}
        {children}
      </span>
    );
  return (
    <button
      type={type}
      data-slot="chip"
      data-selected={selected ? '' : undefined}
      className={cn(
        chipClasses(size),
        'focus-ring press transition-[color,background-color,scale] duration-fast ease-out',
        'enabled:hover:bg-accent enabled:hover:text-foreground data-selected:bg-highlight data-selected:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export type { ChipProps };
