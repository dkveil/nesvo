import type { ComponentProps } from 'react';

import { cn } from '../../libs/ui/cn';

export type TextAreaProps = ComponentProps<'textarea'>;

export const TextArea = ({ className, ...props }: TextAreaProps) => (
  <textarea
    className={cn(
      'w-full resize-none rounded-md border border-border bg-background px-3 py-2 font-mono text-xs',
      'text-text placeholder:text-faint focus-visible:outline-2 focus-visible:outline-accent',
      'disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
    {...props}
  />
);
