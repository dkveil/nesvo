import * as React from 'react';
import { cn } from '@/shared/lib/cn';
import { Separator as SeparatorPrimitive } from 'radix-ui';

type SeparatorProps = React.ComponentProps<typeof SeparatorPrimitive.Root> & {
  label?: React.ReactNode;
};

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  label,
  ...props
}: SeparatorProps) {
  if (label)
    return (
      <div
        data-slot="separator"
        className={cn(
          'flex min-w-0 items-center gap-3 text-2xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border',
          className,
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
      </div>
    );
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-border data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
