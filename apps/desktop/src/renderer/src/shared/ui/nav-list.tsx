import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/shared/lib/cn';

type NavListProps = ComponentProps<'nav'> & { label: string };

export function NavList({ label, className, ...props }: NavListProps) {
  return (
    <nav
      aria-label={label}
      data-slot="nav-list"
      className={cn('flex flex-col gap-0.5', className)}
      {...props}
    />
  );
}

type NavItemProps = ComponentProps<'button'> & {
  icon?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  size?: 'sm' | 'md';
  tone?: 'default' | 'sidebar';
};

export function NavItem({
  icon,
  trailing,
  selected = false,
  size = 'sm',
  tone = 'default',
  type = 'button',
  className,
  children,
  ...props
}: NavItemProps) {
  return (
    <button
      type={type}
      data-slot="nav-item"
      aria-current={selected ? 'page' : undefined}
      data-selected={selected ? '' : undefined}
      className={cn(
        'focus-ring flex w-full min-w-0 items-center gap-2 rounded-control px-2 text-left transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
        size === 'sm' && 'h-7 text-ui',
        size === 'md' && 'h-8 text-ui',
        tone === 'default' &&
          'text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground data-selected:bg-highlight data-selected:font-medium data-selected:text-foreground',
        tone === 'sidebar' &&
          'text-sidebar-muted-foreground enabled:hover:bg-sidebar-row-hover enabled:hover:text-sidebar-foreground data-selected:bg-sidebar-row-selected data-selected:text-sidebar-foreground data-selected:shadow-(--sidebar-row-selected-shadow)',
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-2xs text-muted-foreground tabular-nums">
          {trailing}
        </span>
      )}
    </button>
  );
}
