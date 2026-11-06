import type { ComponentProps } from 'react';

import { cn } from '../../libs/ui/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonProps = ComponentProps<'button'> & { variant?: ButtonVariant };

export const Button = ({
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: ButtonProps) => (
  <button
    type={type}
    className={cn(
      'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium',
      'transition-colors duration-100 focus-visible:outline-2 focus-visible:outline-accent',
      'disabled:cursor-not-allowed disabled:opacity-50',
      variant === 'primary' && 'bg-accent text-accent-ink enabled:hover:brightness-110',
      variant === 'secondary' &&
        'border border-border bg-elevated text-text enabled:hover:bg-selection',
      variant === 'ghost' && 'text-muted enabled:hover:bg-elevated enabled:hover:text-text',
      variant === 'danger' && 'border border-danger text-danger enabled:hover:bg-elevated',
      className,
    )}
    {...props}
  />
);
