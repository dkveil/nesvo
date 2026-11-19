import type { ComponentProps, ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';
import { KeyCombo } from '@/shared/ui/kbd';

type SearchFieldProps = Omit<ComponentProps<'input'>, 'size' | 'type'> & {
  variant?: 'panel' | 'sidebar' | 'underline' | 'palette';
  onClear?: () => void;
  shortcut?: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  containerClassName?: string;
};

export function SearchField({
  variant = 'panel',
  onClear,
  shortcut,
  icon,
  trailing,
  className,
  containerClassName,
  value,
  ...props
}: SearchFieldProps) {
  const filled = typeof value === 'string' ? value.length > 0 : !!value;
  return (
    <div
      data-slot="search-field"
      className={cn(
        'flex shrink-0 items-center gap-2 text-muted-foreground transition-colors duration-fast',
        variant === 'panel' &&
          'focus-ring-within h-8 rounded-control px-2 focus-within:bg-accent hover:bg-accent',
        variant === 'sidebar' &&
          'focus-ring-within h-8 rounded-control px-2 text-sidebar-icon focus-within:bg-sidebar-row-hover hover:bg-sidebar-row-hover',
        variant === 'underline' && 'h-9 border-b px-3 focus-within:border-ring',
        variant === 'palette' && 'h-11 border-b px-3.5',
        containerClassName,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex shrink-0',
          variant === 'palette'
            ? '[&_svg:not([class*=size-])]:size-4'
            : '[&_svg:not([class*=size-])]:size-3.5',
        )}
      >
        {icon ?? <Search />}
      </span>
      <input
        type="search"
        value={value}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-search-cancel-button]:hidden',
          variant === 'palette' ? 'text-sm' : 'text-ui',
          className,
        )}
        {...props}
      />
      {onClear && filled && (
        <IconButton
          label="Clear search"
          size={20}
          tooltip={false}
          tone={variant === 'sidebar' ? 'sidebar' : 'default'}
          onClick={onClear}
        >
          <X />
        </IconButton>
      )}
      {shortcut && !filled && <KeyCombo keys={shortcut} />}
      {trailing}
    </div>
  );
}
