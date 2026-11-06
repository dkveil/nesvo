import type { ComponentProps } from 'react';

import { cn } from '../../libs/ui/cn';

export type PanelVariant = 'surface' | 'inset';
export type PanelProps = ComponentProps<'section'> & { variant?: PanelVariant };

export const Panel = ({ variant = 'surface', className, ...props }: PanelProps) => (
  <section
    className={cn(
      'rounded-lg border border-border p-4',
      variant === 'surface' && 'bg-surface',
      variant === 'inset' && 'bg-background',
      className,
    )}
    {...props}
  />
);
