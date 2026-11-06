import type { ComponentProps } from 'react';

import { cn } from '../../libs/ui/cn';

export type TextFieldProps = ComponentProps<'input'>;

export const TextField = ({ className, ...props }: TextFieldProps) => (
  <input
    className={cn(
      'w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-text',
      'placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
);
