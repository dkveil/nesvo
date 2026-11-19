import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/cn';

type ControlSize = 'sm' | 'md' | 'lg';

type InputProps = Omit<ComponentProps<'input'>, 'size'> & {
  size?: ControlSize;
  variant?: 'default' | 'ghost';
};

function Input({
  className,
  type,
  size = 'sm',
  variant = 'default',
  ...props
}: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        'w-full min-w-0 text-foreground transition-[color,background-color,border-color] duration-fast outline-none selection:bg-primary selection:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50',
        'file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground',
        variant === 'default' && [
          'focus-ring rounded-control border border-input bg-transparent shadow-xs dark:bg-input/30',
          'aria-invalid:border-error-foreground',
          size === 'sm' && 'h-7 px-2 text-ui',
          size === 'md' && 'h-8 px-2.5 text-ui',
          size === 'lg' && 'h-9 px-3 py-1 text-sm',
        ],
        variant === 'ghost' && [
          'border-0 bg-transparent p-0 shadow-none',
          size === 'sm' && 'h-7 text-ui',
          size === 'md' && 'h-8 text-ui',
          size === 'lg' && 'h-9 text-sm',
        ],
        className,
      )}
      {...props}
    />
  );
}

export { Input, type InputProps };
