import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/cn';

type TextareaProps = ComponentProps<'textarea'> & {
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'ghost';
  resize?: 'none' | 'vertical' | 'both';
};

function Textarea({
  className,
  size = 'sm',
  variant = 'default',
  resize = variant === 'ghost' ? 'none' : undefined,
  ...props
}: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      data-size={size}
      className={cn(
        'flex field-sizing-content w-full text-foreground transition-[color,background-color,border-color] duration-fast outline-none disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'default' && [
          'focus-ring min-h-16 rounded-control border border-input bg-transparent shadow-xs dark:bg-input/30',
          'aria-invalid:border-error-foreground',
          size === 'sm' && 'px-2 py-1.5 text-ui',
          size === 'md' && 'px-2.5 py-1.5 text-ui',
          size === 'lg' && 'px-3 py-2 text-sm',
        ],
        variant === 'ghost' && [
          'rounded-none border-0 bg-transparent p-0 shadow-none',
          size === 'lg' ? 'text-sm' : 'text-ui',
        ],
        resize === 'none' && 'resize-none',
        resize === 'vertical' && 'resize-y',
        resize === 'both' && 'resize',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea, type TextareaProps };
