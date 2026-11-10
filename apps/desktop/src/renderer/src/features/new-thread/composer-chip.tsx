import type { ComponentProps } from 'react';
import { cn } from 'cn';

export type ComposerChipProps = ComponentProps<'button'>;

export function ComposerChip({ className, ...props }: ComposerChipProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-[color,background-color,scale] duration-150 ease-out outline-none',
        'enabled:hover:bg-accent enabled:hover:text-foreground enabled:active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=open]:bg-accent data-[state=open]:text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-64 [&_svg]:size-3.5 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}
