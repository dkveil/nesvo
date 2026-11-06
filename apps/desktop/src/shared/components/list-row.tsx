import type { ComponentProps } from 'react';

import { cn } from '../../libs/ui/cn';

export type ListRowVariant = 'default' | 'attention';
export type ListRowProps = ComponentProps<'li'> & { variant?: ListRowVariant };

export const ListRow = ({ variant = 'default', className, ...props }: ListRowProps) => (
  <li
    className={cn(
      'flex items-center gap-3 rounded-md border px-3 py-2 transition-colors duration-100',
      variant === 'default' && 'border-border bg-surface',
      variant === 'attention' && 'border-warning bg-selection',
      className,
    )}
    {...props}
  />
);
